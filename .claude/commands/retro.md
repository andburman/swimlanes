The user has identified unwanted agent behavior in this session. Run an ad-hoc retro to capture it.

## Steps

1. **Identify the behavior** — Review what just happened in this conversation. What did the agent do wrong? Common issues: skipping discovery, jumping to implementation without adding to graph, not pausing after tasks, ignoring graph workflow, not checking knowledge first.

2. **Root cause** — Why did it happen? Missing instruction in CLAUDE.md? Ambiguous rule? Agent prompt gap? Convention not enforced by tooling?

3. **Propose a fix** — Draft the exact CLAUDE.md instruction or graph knowledge entry that would prevent this in future sessions. Present it to the user for approval.

4. **Record it** — Based on user approval:
   - Add to CLAUDE.md if it's a behavioral rule the default agent should always follow
   - Write as graph knowledge if it's project-specific context
   - Add as a graph node via `graph_plan` if it needs tooling changes

5. **Confirm** — Show the user what was recorded and where.
