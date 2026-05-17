# Contributing to Rescue Bot

Thank you for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a branch: `git checkout -b feature/your-feature`
4. Make changes
5. Run tests: `npm test`
6. Commit: `git commit -m "feat: description"`
7. Push and create PR

## Commit Messages

Use conventional commits:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `refactor:` Code refactoring
- `test:` Test changes
- `chore:` Build/tooling

## Code Style

- ES Modules (import/export)
- No semicolons
- 2-space indentation
- Descriptive variable names

## Testing

- Add unit tests for new utilities
- Update integration tests for API changes
- Run `make eval` for agent behavior tests
- Run `make test` for full test suite

## Pull Requests

- Clear description of changes
- Link related issues
- Pass all CI checks
- Request review from maintainers

## Site Customization

- All org-specific content should go in `site/`
- Use `site.example/` as a template
- Never commit your `site/` directory to the main repository
- Org-specific deploy config (account ID, domain, D1 IDs) lives in `org.env` (gitignored). See README.md → "Fork and deploy" for the full flow.

## Development Workflow

### Local Development
```bash
# Two paths for org-specific config — pick one:
#   make cf-init-org     interactive: prompts + creates CF resources + writes org.env
#   make cf-init-config  manual: copy org.env.example, edit 6 values yourself
make cf-init-org               # recommended for forks (you don't have CF resources yet)
# OR
# make cf-init-config && $EDITOR org.env

cp .env.example .env           # add your API keys
make cf-setup                  # deps + render wrangler.toml + local D1 migrations

# Start dev server (picks a free port, prints the URL)
make cf-dev

# Run tests (vitest + worktree shell test)
make test

# Run evaluations (requires `make cf-dev` running in another terminal)
make eval
```

### Working with multiple worktrees

`make cf-dev` is worktree-aware. Each `git worktree` gets its own port and isolated wrangler state, so two `make cf-dev`s in two worktrees can run side-by-side without colliding. `make cf-stop` kills only the current worktree's wrangler. See README.md → "Working with multiple worktrees" for details.

### Dev/test/prod model

- **Local dev**: `make cf-dev` (worktree-aware port)
- **Test**: every PR auto-deploys to `wildcare-bot-test.<account>.workers.dev` (mid-fidelity, real auth via magic link). Open PRs serialize on the `deploy-test-shared` concurrency group, no stomping.
- **Production**: push to main auto-deploys to your prod domain.

### Adding New Features

1. Check if the feature should be generic (in main codebase) or site-specific (in site/)
2. Write tests first (TDD approach)
3. Implement the feature
4. Update documentation
5. Run full test suite

### Working with the Agent

- Agent instruction is in `agents/rescue-bot-instruction.md`
- Site-specific instructions go in `site/agent-instruction.md`
- RAG resources go in `resources/` (generic) or `site/resources/` (org-specific)
- Test agent changes with `make eval`

## Questions?

Open an issue or reach out to the maintainers.
