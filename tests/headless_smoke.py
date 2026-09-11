from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.headless_service import headless_sessions


def _workspace():
    return {
        "activeLayers": [
            {
                "uniqueKey": "layer-1",
                "displayName": "Roads",
                "isFolder": False,
                "isVisible": True,
            },
            {
                "uniqueKey": "folder-1",
                "displayName": "Maps",
                "isFolder": True,
                "isVisible": True,
            },
        ]
    }


def run():
    plan = headless_sessions.summarize_plan("zoom to roads and open table", workspace=_workspace())
    assert any(a["type"] == "zoom_to_layer" for a in plan["actions"])
    assert any(a["type"] == "open_table" for a in plan["actions"])

    style = headless_sessions.execute_action("apply_style", {"layerKey": "layer-1", "style": {"type": "single"}}, confirmed=True)
    assert style["output"]["workspace_updates"][0]["op"] == "apply_style"

    export = headless_sessions.execute_action("export_workspace", {"workspace": _workspace()}, confirmed=True)
    assert export["output"]["workspace_updates"][0]["op"] == "export_workspace"

    print("headless smoke ok")


if __name__ == "__main__":
    run()
