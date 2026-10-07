dev:
    bun --hot server.ts

test:
    bun test

e2e:
    bun e2e.ts

types:
    bun scripts/update-types.ts
