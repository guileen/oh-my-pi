Regex: Rust, then PCRE2. `path`: `;`-separated file/dir/glob/URL; default `.`. Default case-sensitive, gitignore respected; `skip` paginates files.
File-only selector: `src/foo.ts:50-100`. Literal `\n`/`\\n` enables cross-line.
Bare glob `*.ts` matches any depth; `dir/*.ts` only `dir`'s direct children (`dir/**/*.ts` recurses). A `!glob` entry excludes matching files and folders below the searched paths (`src;!**/*.test.ts`).
{{#if hasFind}}Behavior/unknown symbol → `find`; literals/regex → `grep`.{{/if}}
{{#if eagerDelegation}}Multi-round search MUST use {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}, not chained calls.{{/if}}
With `rewind` available, resolved search has disposable exploration? MUST fuse retirement and the next source read using `read: ["path:start-end"]`, the returned `observationId`, a one-line decision `note`, and `nextAction` AFTER those reads. One action returns original numbered source and edit tags; reads complete even without a worthwhile cut. Skip retirement only when the whole interval, including completed reasoning/tool chains, is small and useful.
