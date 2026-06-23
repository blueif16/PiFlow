// A tiny Claude Code Workflow fixture for the parse-claude-workflow bridge test. Exercises: a serial
// node, a parallel group, and the full marker family (artifacts/owns/read-scope/tools/checks/policy/
// return/fill-sentinel) embedded in the realized prompts. NOT a real pipeline — a parser fixture.
export const meta = { name: 'sample', description: 'fixture: serial → parallel, with contract markers' };

phase('Design');
const checks = Buffer.from(JSON.stringify([{ kind: 'count-floor', path: 'spec/gdd.md', param: { path: 'milestones', min: 3 } }])).toString('base64');
const policy = Buffer.from(JSON.stringify({ fail: 'block' })).toString('base64');
await agent(
  [
    'Write the game design document.',
    '',
    'DRIVER-ARTIFACTS: spec/gdd.md',
    'DRIVER-OWNS: spec/',
    'DRIVER-READ-SCOPE: spec/ packages/skills/write-gdd',
    'DRIVER-RETURN: optional',
    'DRIVER-FILL-SENTINEL: <FILL:',
    `DRIVER-CHECKS: ${checks}`,
    `DRIVER-POLICY: ${policy}`,
  ].join('\n'),
  { label: 'W1 Design' },
);

phase('Assets');
await parallel([
  () => agent('Author the art prompts.\n\nDRIVER-ARTIFACTS: asset-prompts.json\nDRIVER-TOOLS: read,write', { label: 'W3a Art' }),
  () => agent('Generate the assets.\n\nDRIVER-ARTIFACTS: public/assets\nDRIVER-EXCLUDE-TOOLS: edit', { label: 'W3b Assets' }),
]);

phase('Build');
await agent('Build the milestone from the frozen spec.\n\nDRIVER-ARTIFACTS: src/index.ts\nDRIVER-OWNS: src/', { label: 'W4 Execute' });
