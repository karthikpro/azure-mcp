import { describe, expect, it } from 'vitest';

import { McpError } from '../src/errors.js';
import {
  compactObject,
  parseResourceUri,
  toJsonPatch,
  validateWiql,
} from '../src/utils.js';

describe('compactObject', () => {
  it('removes undefined values while preserving null values', () => {
    expect(
      compactObject({
        organization: undefined,
        project: 'demo-project',
        description: null,
      }),
    ).toEqual({
      project: 'demo-project',
      description: null,
    });
  });
});

describe('parseResourceUri', () => {
  it('parses Azure DevOps work item resource URIs', () => {
    expect(
      parseResourceUri('azure-devops://contoso/DemoProject/workitems/42'),
    ).toEqual({
      organization: 'contoso',
      project: 'DemoProject',
      id: 42,
    });
  });

  it('rejects unsupported resource URIs', () => {
    expect(() => parseResourceUri('azure-devops://contoso/DemoProject/boards/42')).toThrow(
      McpError,
    );
  });
});

describe('validateWiql', () => {
  it('accepts read-only work item queries', () => {
    expect(
      validateWiql('SELECT [System.Id] FROM WorkItems WHERE [System.State] = \'Active\''),
    ).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'");
  });

  it('rejects dangerous tokens', () => {
    expect(() =>
      validateWiql('SELECT [System.Id] FROM WorkItems; DELETE FROM WorkItems'),
    ).toThrow(McpError);
  });
});

describe('toJsonPatch', () => {
  it('adds a revision test before field updates when rev is provided', () => {
    expect(toJsonPatch({ 'System.Title': 'Hello' }, 7)).toEqual([
      {
        op: 'test',
        path: '/rev',
        value: 7,
      },
      {
        op: 'add',
        path: '/fields/System.Title',
        value: 'Hello',
      },
    ]);
  });
});
