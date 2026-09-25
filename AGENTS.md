# Instructions for coding agents in varis-ts

This repository holds the public TypeScript SDK for Varis, a marketplace where
AI agents pay to call HTTPS services that developers publish. It publishes two
npm packages. Production servers install only the first one, so they never
download the TypeScript compiler.

| Package | Directory | Purpose |
| --- | --- | --- |
| `@usevaris/sdk` | `packages/sdk` | Runs in the developer's server. Exports `Varis`, `services.define`, and `verifyRequest`. |
| `@usevaris/build` | `packages/build` | The generator. The Varis CLI runs it on demand with `npx --yes @usevaris/build@<major>`. Developers never install it. |

## Layout

```
varis-ts/
├── package.json            Private workspace root. Scripts run across packages.
├── tsconfig.json           Shared compiler options. Both packages extend it.
├── openapi.yaml            The Varis API description.
├── packages/sdk/
│   ├── src/index.ts        Varis, Services, and define.
│   ├── src/types.ts        ServiceDefinition, ServiceType, ServiceStatus, ServiceCategory.
│   ├── src/verify.ts       verifyRequest, VarisOptions, VarisKeyFetchError.
│   ├── src/constants.ts    VARIS_API_ORIGIN and VARIS_SIGNING_KEYS_URL.
│   ├── docs/agents.md      Shipped instructions for coding agents in developers' projects.
│   └── test/
└── packages/build/
    ├── src/cli.ts          The varis-build command and its output contract.
    ├── src/build.ts        The pipeline. Start here.
    ├── src/find.ts         Loads the project and finds define calls.
    ├── src/read.ts         Reads the literal values in a define call.
    ├── src/convert.ts      Turns Input and Output types into JSON Schemas.
    ├── src/write.ts        Writes varis.json.
    ├── src/warnings.ts     Non-fatal warnings printed on success.
    ├── src/errors.ts       BuildError and BuildFailure.
    └── test/
```

## Commands

Run these from the repository root:

- `npm install`: installs every workspace.
- `npm run build`: compiles both packages to `dist/` with `tsc6`.
- `npm run typecheck`: type checks the source and tests of both packages.
- `npm test`: runs every package's Vitest suite.

To work on one package, add `--workspace packages/sdk` or
`--workspace packages/build`.

## Rules

### Tooling

- Use `@typescript/typescript6` for everything. Its `tsc6` binary builds both
  packages, and the generator imports the compiler API from it. Never install
  or import `typescript`: version 7 on npm has no programmatic API.
- Use ES modules everywhere. End relative imports in `.js`.

### The SDK

- Keep `@usevaris/sdk` free of runtime dependencies. Its `package.json` has no
  `dependencies` field.
- Never import from `node:` in `packages/sdk`. The SDK runs on Node 22.13 and
  later, Deno, Bun, and Cloudflare Workers. Its `tsconfig.json` sets
  `"types": []` so that Node-only APIs fail to type check.
- Keep the Varis hostname in `packages/sdk/src/constants.ts` only.
- `Varis` never holds a credential. Its options configure request verification
  only.
- The signing format in `src/verify.ts` must match the gateway in the private
  `varis` repository (`lib/crypto/signing.ts` and
  `app/.well-known/varis-signing-keys/route.ts`). If you change one, change
  the other.
- Change `packages/sdk/docs/agents.md` in the same commit as any public API
  change.
- Add new field validation to the `ServiceDefinition` type in
  `src/types.ts` first. The generator reports its type errors automatically.
  Change the generator only when a type can't express the rule.
- `ServiceCategory` mirrors `ServiceCategory` in `openapi.yaml`. Adding a value
  is safe. Renaming one isn't.

### The generator

- Never run the developer's code. The generator reads it with the TypeScript
  compiler only.
- `@usevaris/build` never depends on `@usevaris/sdk`. It finds `define` in
  whatever copy of the SDK the developer's project resolves. In tests,
  `makeProject` maps `@usevaris/sdk` to `packages/sdk/src/index.ts` through
  `paths`.
- `find.ts` looks for a class named `Services` with a method named `define`,
  in a package named `@usevaris/sdk`. If you rename any of them, update
  `find.ts` in the same change.
- The output of `cli.ts` is a protocol that the Varis CLI and every other
  language's generator share. Don't change exit codes, streams, or JSON shapes
  without changing all of them together.
  - Exit 0: stdout holds one JSON line, `{ "services": [...], "warnings": [...] }`.
  - Exit 1: stderr holds one JSON line per problem, `{ "file", "line", "message" }`.
  - Exit 2: the generator crashed. stderr holds one JSON line with the details.
- Warnings go in the stdout `warnings` array only, never to stderr. Add them
  in `warnings.ts`.
- Write only those JSON lines to stdout and stderr. No `console.log`,
  progress messages, or colors.
- Keep the shebang as the first line of `cli.ts`.
- Collect every problem before failing. Push a `BuildError` and keep going.
  Throw `BuildFailure` directly only when there is no point continuing.
- Write nothing to `varis.json` if any problem is found.
- Write error messages as full sentences that say what to do.
- When you add a field to `ServiceDefinition`, add it to `FIELD_ORDER` in
  `write.ts`.

### Documentation

Follow the Google developer documentation style guide: second person, active
voice, present tense, and sentence-case headings. Don't use em dashes.
