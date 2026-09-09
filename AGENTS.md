# Repository Guidelines

## Project Structure & Module Organization

This repository is at its initial scaffolding stage. `LICENSE` contains the MIT license; there is no application source, test suite, or asset directory yet. `.agents/` and `.codex/` are reserved for local agent configuration.

When adding the first implementation, establish a clear layout, such as `src/` for source, `tests/` for tests, and `assets/` for static resources. Document the chosen structure and setup steps in a root `README.md`. These directories are suggestions, not existing conventions.

## Build, Test, and Development Commands

No build system, dependency manifest, or development commands are configured. Do not assume commands such as `npm test` or `make build` work.

Useful checks currently available:

- `git status --short`: review pending changes.
- `git diff --check`: detect whitespace errors in tracked changes.
- `git diff`: inspect unstaged changes to tracked files.

When introducing tooling, document exact installation, local execution, build, and test commands in `README.md`.

## Coding Style & Naming Conventions

No language, indentation standard, formatter, or linter has been selected. Match surrounding files when editing existing content. For new code, choose consistent language-appropriate naming and indentation, and commit formatter or linter configuration with the implementation. Keep Markdown headings descriptive and instructions concise.

## Testing Guidelines

No testing framework or coverage threshold exists. When adding executable functionality, include appropriate automated tests and document how to run them. Name tests after the behavior they verify and follow the selected framework’s discovery conventions.

## Commit & Pull Request Guidelines

Git history contains only `Initial commit`, so no established commit convention can be inferred. Use short, imperative subjects such as `Add diary entry model` and keep commits focused.

Pull requests should explain the change, list validation performed, and link relevant issues. Include screenshots for visible UI changes. Clearly state when tests could not be run or tooling is still unconfigured.
