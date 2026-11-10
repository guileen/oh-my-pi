Regex: Rust, then PCRE2. `path`: `;`-separated file/dir/glob/URL; default `.`. Default case-sensitive, gitignore respected; `skip` paginates files.
File-only selector: `src/foo.ts:50-100`. Literal `\n`/`\\n` enables cross-line.
Bare glob `*.ts` matches any depth; `dir/*.ts` only `dir`'s direct children (`dir/**/*.ts` recurses). A `!glob` entry excludes matching files and folders below the searched paths (`src;!**/*.test.ts`).
{{#if hasFind}}Behavior/unknown symbol → `find`; literals/regex → `grep`.{{/if}}
{{#if eagerDelegation}}Multi-round search MUST use {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}, not chained calls.{{/if}}
With `rewind` available, `searchId` marks the safe boundary before this search. Once located, read the needed ranges, then rewind that search while retaining the displayed code; no separate checkpoint is needed for a small decision.
