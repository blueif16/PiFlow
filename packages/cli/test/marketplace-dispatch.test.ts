// Dispatch gate for the P0 marketplace verbs — `agents` · `catalog` · `skill`. cli.ts executes `main()` at
// import (it IS the bin), so the switch can't be exercised by importing it in-process; the gate here is a
// SOURCE-content check (the skill-assets-parity.test.ts precedent): each verb must have a live `case` wired
// to its run*Cli entry AND a HELP line, so a dropped case or an undocumented verb reddens this file. The
// verbs' BEHAVIOR is covered by their own suites (agents-cli / catalog-cli / skill-cli / skill-add).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_TS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts'),
  'utf8',
);

describe('cli.ts — the P0 marketplace verbs are dispatched and documented', () => {
  it("dispatches `agents` to runAgentsCli", () => {
    expect(CLI_TS).toMatch(/case 'agents':/);
    expect(CLI_TS).toMatch(/runAgentsCli\(rest\)/);
  });

  it("dispatches `catalog` to runCatalogCli", () => {
    expect(CLI_TS).toMatch(/case 'catalog':/);
    expect(CLI_TS).toMatch(/runCatalogCli\(rest\)/);
  });

  it("dispatches `skill` to runSkillCli — WITHOUT shadowing the existing `skills` verb", () => {
    expect(CLI_TS).toMatch(/case 'skill':/);
    expect(CLI_TS).toMatch(/runSkillCli\(rest\)/);
    expect(CLI_TS).toMatch(/case 'skills':/); // the pre-existing verb stays
  });

  it('the HELP usage block names each new verb with its subcommands', () => {
    expect(CLI_TS).toMatch(/piflowctl agents\s+list/);
    expect(CLI_TS).toMatch(/piflowctl catalog\s+sync/);
    expect(CLI_TS).toContain('introspect <server>');
    expect(CLI_TS).toMatch(/piflowctl skill\s+list/);
    expect(CLI_TS).toContain('add <source>');
  });
});
