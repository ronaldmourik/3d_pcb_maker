# Contributing

Issues and pull requests are welcome. For larger changes, open an issue first so we can agree on the approach.

## Reporting bugs

Use the bug report form. The most useful thing you can attach is a zip of the Gerber and drill files that show the problem, plus the trace mode and any settings you changed.

## Development setup

You need Node.js 24 (the version CI uses).

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # parser + geometry tests (OpenCascade runs in Node)
npx tsc          # type check
npm run build    # static site in dist/
```

See the *Structure* section in the [README](README.md) for where things live.

## Tests

- Geometry changes should come with a test. The existing tests check exact volumes and topology of the generated solids, so a change in output shows up as a number, not as a picture.
- Real KiCad exports live in `tests/fixtures/`. Add a new fixture when a bug only shows up with a specific board, and keep it small.
- Parser changes should have a unit test with a minimal Gerber or Excellon snippet.

## Pull requests

- Branch from `main` and keep each pull request focused on one change.
- Run `npx tsc` and `npm test` before you push. CI runs both and must pass before merging.
- If you change files in `public/`, bump the `CACHE` name in `public/sw.js`, otherwise installed copies keep the old files.
- Pull requests are squash-merged, so the title becomes the commit message. Write it as a short imperative sentence ("Add …", "Fix …").

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
