from __future__ import annotations

import io
import logging
import sys

from flask import Flask, jsonify, make_response, render_template, send_from_directory

from config import ensure_storage_files
from routes.headless import headless_bp
from routes.geometry import geometry_bp
from routes.proxy import proxy_bp
from routes.search import search_bp
from routes.servers import servers_bp


class MuteApiLogsFilter(logging.Filter):
    def filter(self, record):
        return '/api/logs' not in record.getMessage()


class LogCatcher(io.StringIO):
    def __init__(self, original_stdout):
        super().__init__()
        self.original_stdout = original_stdout
        self.logs = []

    def write(self, message):
        self.original_stdout.write(message)
        if message.strip():
            self.logs.append(message.strip())

    def flush(self):
        self.original_stdout.flush()

    def get_and_clear_logs(self):
        current_logs = self.logs[:]
        self.logs.clear()
        return current_logs


logging.getLogger('werkzeug').addFilter(MuteApiLogsFilter())


def create_app() -> Flask:
    ensure_storage_files()

    app = Flask(__name__)

    sys_logger = LogCatcher(sys.stdout)
    sys.stdout = sys_logger
    sys.stderr = sys_logger
    app.config['SYS_LOGGER'] = sys_logger

    @app.route('/sw.js')
    def serve_service_worker():
        response = make_response(send_from_directory(app.static_folder, 'sw.js'))
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return response

    @app.route('/api/logs', methods=['GET'])
    def get_logs():
        return jsonify({'logs': app.config['SYS_LOGGER'].get_and_clear_logs()})

    @app.route('/')
    def index():
        response = make_response(render_template('index.html'))
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return response

    app.register_blueprint(servers_bp)
    app.register_blueprint(search_bp)
    app.register_blueprint(proxy_bp)
    app.register_blueprint(headless_bp)
    app.register_blueprint(geometry_bp)

    return app


app = create_app()


if __name__ == '__main__':
    print(f"🚀 Writing Database to: {app.root_path}")
    app.run(debug=True, port=5000)
