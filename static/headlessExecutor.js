// Headless execution is deliberately map-agnostic. The application supplies
// the workspace adapter and renderer callbacks; this module only executes a
// validated plan and reports results.
import { executeAction } from './headlessApi.js';

export async function executeActionPlan(plan, options = {}, context = {}) {
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];
    const confirmSet = new Set(plan?.confirmations || []);
    const executed = [];
    for (const action of actions) {
        const actionType = action?.type;
        if (!actionType || (confirmSet.has(actionType) && !options.confirmed)) continue;
        let data;
        try {
            data = await executeAction(actionType, action.input || {}, { confirmed: Boolean(options.confirmed), planHash: plan.planHash || null });
        } catch (error) {
            context.card?.(`Failed: ${actionType}`, [error.message || `Failed to execute ${actionType}`], 'error');
            throw error;
        }
        executed.push(data);
        context.onResult?.(data);
        context.applyUpdates?.({ result: { actions: [data] } });
        const output = data.output || {};
        const summary = [];
        if (Array.isArray(output.workspace_updates) && output.workspace_updates.length) summary.push(`workspace updates: ${output.workspace_updates.map(u => u.op).join(', ')}`);
        if (typeof output.feature_count === 'number') summary.push(`features: ${output.feature_count}`);
        if (typeof output.count === 'number') summary.push(`count: ${output.count}`);
        if (output.message) summary.push(output.message);
        if (Array.isArray(output.search_diagnostics)) summary.push(...output.search_diagnostics);
        ['deleted', 'duplicated', 'moved', 'renamed', 'selected', 'styled', 'exported', 'opened'].forEach(flag => { if (output[flag]) summary.push(flag); });
        if (output.visibility_changed) summary.push(`visibility: ${output.visibility_changed}`);
        if (Array.isArray(output.candidates)) {
            summary.push(`discovered ${output.candidates.length} candidate source(s)`);
            output.candidates.slice(0, 10).forEach(candidate => context.card?.(`Source: ${candidate.title || candidate.url}`, [
                `Protocol: ${candidate.protocol || 'unknown'} | Confidence: ${Math.round((candidate.confidence || 0) * 100)}%`, candidate.description || 'No description provided.', `URL: ${candidate.url}`, candidate.validation_message || 'Not yet validated.'
            ], candidate.validation_status === 'valid' ? 'success' : 'neutral', { open: false }));
        }
        context.card?.(`Executed: ${actionType}`, summary.length ? summary : ['completed'], 'success', { open: false });
    }
    if (confirmSet.size && !options.confirmed) context.card?.('Paused', [`Waiting before: ${[...confirmSet].join(', ')}`], 'warn', { open: true });
    return executed;
}
