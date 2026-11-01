import { z } from 'zod';

const modifiers = {
  exact: z.boolean().optional(),
  nth: z.number().int().min(0).optional(),
};

/** One element on the page. Maps to Playwright's getByRole, getByLabel, getByText, ... */
export const LocatorSchema = z.union([
  z.strictObject({ role: z.string().min(1), name: z.string().optional(), ...modifiers }),
  z.strictObject({ label: z.string(), ...modifiers }),
  z.strictObject({ text: z.string(), ...modifiers }),
  z.strictObject({ placeholder: z.string(), ...modifiers }),
  z.strictObject({ testid: z.string(), ...modifiers }),
  z.strictObject({ css: z.string(), ...modifiers }),
]);
export type LocatorSpec = z.infer<typeof LocatorSchema>;

const stepCommon = {
  timeout_ms: z.number().int().positive().optional(),
  optional: z.boolean().optional(),
};

const WaitState = z.enum(['visible', 'hidden', 'attached', 'detached']);

export const STEP_SCHEMAS = {
  goto: z.strictObject({ goto: z.string().min(1), ...stepCommon }),
  click: z.strictObject({ click: LocatorSchema, ...stepCommon }),
  fill: z.strictObject({
    fill: z.strictObject({ target: LocatorSchema, value: z.string() }),
    ...stepCommon,
  }),
  press: z.strictObject({ press: z.string().min(1), ...stepCommon }),
  select: z.strictObject({
    select: z.strictObject({ target: LocatorSchema, value: z.string() }),
    ...stepCommon,
  }),
  check: z.strictObject({ check: LocatorSchema, ...stepCommon }),
  uncheck: z.strictObject({ uncheck: LocatorSchema, ...stepCommon }),
  hover: z.strictObject({ hover: LocatorSchema, ...stepCommon }),
  scroll_to: z.strictObject({ scroll_to: LocatorSchema, ...stepCommon }),
  switch_tab: z.strictObject({
    switch_tab: z.union([z.string().min(1), z.number().int().min(0)]),
    ...stepCommon,
  }),
  wait_for: z.strictObject({
    wait_for: z.union([
      LocatorSchema,
      z.strictObject({ target: LocatorSchema, state: WaitState.optional() }),
    ]),
    ...stepCommon,
  }),
  expect_text: z.strictObject({
    expect_text: z.strictObject({
      target: LocatorSchema,
      text: z.string(),
      exact: z.boolean().optional(),
    }),
    ...stepCommon,
  }),
  expect_visible: z.strictObject({ expect_visible: LocatorSchema, ...stepCommon }),
  expect_hidden: z.strictObject({ expect_hidden: LocatorSchema, ...stepCommon }),
  expect_url: z.strictObject({
    expect_url: z.union([
      z.string().min(1),
      z.strictObject({ contains: z.string() }),
      z.strictObject({ matches: z.string() }),
    ]),
    ...stepCommon,
  }),
  screenshot: z.strictObject({
    screenshot: z.union([
      z.literal(true),
      z.strictObject({
        name: z.string().optional(),
        full_page: z.boolean().optional(),
        target: LocatorSchema.optional(),
      }),
    ]),
    ...stepCommon,
  }),
  capture: z.strictObject({
    capture: z.union([
      z.literal(true),
      z.strictObject({ full_page: z.boolean().optional(), target: LocatorSchema.optional() }),
    ]),
    ...stepCommon,
  }),
} as const;

export type StepType = keyof typeof STEP_SCHEMAS;
export const STEP_TYPES = Object.keys(STEP_SCHEMAS) as StepType[];
export type StepOf<K extends StepType> = z.infer<(typeof STEP_SCHEMAS)[K]>;

export const StepSchema = z.union(
  Object.values(STEP_SCHEMAS) as [
    (typeof STEP_SCHEMAS)['goto'],
    (typeof STEP_SCHEMAS)['click'],
    ...(typeof STEP_SCHEMAS)[StepType][],
  ],
);
export type Step = z.infer<typeof StepSchema>;

const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ParamSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  env: z.string().regex(ident, 'must be an environment variable name').optional(),
});
export type ParamSpec = z.infer<typeof ParamSchema>;

export const FlowSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  base_url: z.string().url().optional(),
  allowed_hosts: z.array(z.string().min(1)).optional(),
  params: z.record(z.string().regex(ident, 'must be a valid param name'), ParamSchema).optional(),
  steps: z.array(StepSchema).min(1),
  on_fail: z.enum(['capture', 'none']).optional(),
});
export type Flow = z.infer<typeof FlowSchema>;

/** The one known step key a (validated) step uses. */
export function stepTypeOf(step: Record<string, unknown>): StepType | undefined {
  return STEP_TYPES.find((type) => type in step);
}

/** JSON Schema for editors and agents; written to schema/flow.schema.json by `npm run build:schema`. */
export function flowJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(FlowSchema, { io: 'input', unrepresentable: 'any' }),
    title: 'reproflow flow',
    description: 'A saved browser flow replayed by `reproflow run <name>`.',
  };
}
