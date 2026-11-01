import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowInvalidError, parseFlow } from '../../src/flows/load.js';
import { flowJsonSchema, STEP_TYPES } from '../../src/flows/schema.js';

const examples = join(__dirname, '..', '..', 'examples', 'flows');

/** Parses YAML and returns the issues as `path: message` strings (empty when valid). */
function issuesOf(yaml: string): string[] {
  try {
    parseFlow(yaml, 'test.yaml');
    return [];
  } catch (error) {
    if (error instanceof FlowInvalidError) {
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    throw error;
  }
}

const base = (extra: string): string => `
name: t
base_url: http://localhost:3000
${extra}`;

describe('flow files', () => {
  it.each(readdirSync(examples))('example %s is valid', (file) => {
    expect(issuesOf(readFileSync(join(examples, file), 'utf8'))).toEqual([]);
  });

  it('accepts every step type', () => {
    const flow = parseFlow(
      base(`
params:
  p: {type: string, default: x}
steps:
  - goto: /a/{{p}}
  - click: {role: button, name: Add}
  - fill: {target: {label: Email}, value: "{{p}}"}
  - press: Enter
  - select: {target: {label: Size}, value: M}
  - check: {label: Terms}
  - uncheck: {label: Terms}
  - hover: {text: Menu}
  - scroll_to: {css: footer}
  - switch_tab: 1
  - switch_tab: help
  - wait_for: {role: status}
  - wait_for: {target: {role: status}, state: hidden}
  - expect_text: {target: {testid: total}, text: "$1", exact: true}
  - expect_visible: {placeholder: Search}
  - expect_hidden: {css: .spinner}
  - expect_url: /cart
  - expect_url: {contains: cart}
  - expect_url: {matches: "^/c"}
  - screenshot: true
  - screenshot: {name: cart, full_page: true, target: {css: main}}
  - capture: true
  - capture: {full_page: true}
  - click: {role: link, name: Cart, exact: true, nth: 1}
    timeout_ms: 500
    optional: true
on_fail: none
`),
      'ok.yaml',
    );
    expect(flow.steps).toHaveLength(24);
    expect(STEP_TYPES).toHaveLength(17);
  });

  it('reports every issue with its YAML path and line', () => {
    const yaml = base(`steps:
  - click: {rol: button}
  - goto: 42
  - clik: {text: x}
  - click: {role: button}
    timeout_ms: soon
bogus: 1
`);
    const issues = issuesOf(yaml);
    expect(issues.length).toBeGreaterThanOrEqual(5);
    expect(issues.join('\n')).toMatch(/steps\[0\]\.click/);
    expect(issues.join('\n')).toMatch(/steps\[1\]\.goto/);
    expect(issues.join('\n')).toMatch(/steps\[2\]: unknown step \(found keys: clik\)/);
    expect(issues.join('\n')).toMatch(/steps\[3\]\.timeout_ms/);
    expect(issues.join('\n')).toMatch(/bogus|Unrecognized key/);

    try {
      parseFlow(yaml, 'test.yaml');
    } catch (error) {
      const lines = (error as FlowInvalidError).issues.map((issue) => issue.line);
      expect(lines.every((line) => typeof line === 'number')).toBe(true);
      expect(lines).toContain(5); // the "click: {rol: button}" step
    }
  });

  it('flags a flow with no steps and a missing name', () => {
    const issues = issuesOf('base_url: http://localhost:3000\nsteps: []\n');
    expect(issues.join('\n')).toMatch(/name/);
    expect(issues.join('\n')).toMatch(/steps/);
  });

  it('rejects unknown params in templates', () => {
    const issues = issuesOf(base('steps:\n  - goto: /p/{{sku}}\n'));
    expect(issues).toEqual([
      'steps[0].goto: unknown param "sku" in {{sku}} (params: none declared)',
    ]);
  });

  it('accepts {{env.NAME}} and rejects malformed templates', () => {
    expect(issuesOf(base('steps:\n  - goto: /p/{{env.SKU}}\n'))).toEqual([]);
    expect(issuesOf(base('steps:\n  - goto: "/p/{{a b}}"\n')).join()).toMatch(/bad template/);
  });

  it('requires base_url for relative gotos', () => {
    const issues = issuesOf('name: t\nsteps:\n  - goto: /cart\n');
    expect(issues).toEqual(['steps[0].goto: a relative URL needs base_url']);
    expect(issuesOf('name: t\nsteps:\n  - goto: http://localhost:3000/cart\n')).toEqual([]);
  });

  it('refuses defaults on secret params and mismatched default types', () => {
    const secret = issuesOf(
      base(
        'params:\n  pw: {type: string, secret: true, default: hunter2}\nsteps:\n  - press: Enter\n',
      ),
    );
    expect(secret.join()).toMatch(/secret param must not have a default/);
    const typed = issuesOf(
      base('params:\n  n: {type: number, default: "3"}\nsteps:\n  - press: Enter\n'),
    );
    expect(typed.join()).toMatch(/default must be a number/);
  });

  it('wants bare hostnames in allowed_hosts', () => {
    const issues = issuesOf(
      base('allowed_hosts: ["https://x.com", ok.com]\nsteps:\n  - press: Enter\n'),
    );
    expect(issues).toEqual(['allowed_hosts[0]: use a bare hostname, without scheme, port or path']);
  });

  it('reports YAML syntax errors with a line', () => {
    expect(() => parseFlow('name: [unclosed\n', 'broken.yaml')).toThrow(FlowInvalidError);
  });
});

describe('JSON Schema export', () => {
  const schema = flowJsonSchema() as {
    $schema: string;
    properties: Record<string, unknown>;
    required: string[];
  };

  it('describes the flow file', () => {
    expect(schema.$schema).toContain('json-schema.org');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        'name',
        'description',
        'base_url',
        'allowed_hosts',
        'params',
        'steps',
        'on_fail',
      ]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(['name', 'steps']));
  });

  it('lists every step type in the steps schema', () => {
    const text = JSON.stringify(schema);
    for (const type of STEP_TYPES) expect(text).toContain(`"${type}"`);
  });

  it('is what schema/flow.schema.json contains (npm run build writes it)', () => {
    const file = join(__dirname, '..', '..', 'schema', 'flow.schema.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(schema)));
  });
});
