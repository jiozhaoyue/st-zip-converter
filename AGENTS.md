<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# Custom Agent Guidelines

- **问答交互规范 (Interactive Ask Question Mandate)**:
  - 遇到需要用户决策、澄清需求、确认配置方案、选择技术路线或任何需要用户输入时，**必须使用交互式问答工具 (`ask_question`)**，严禁输出纯文本让用户手动打字回复。
  - 每次提问必须**聚合多个问题**（涵盖方案选项、细节偏好与技术策略），一次性呈现给用户，避免单条零散交互。

- **代码编辑与文件修改规范 (Strict Diff & Prohibit Command Writing Mandate)**:
  - **强制使用 diff 工具**: 修改任何现有文件时，**必须且只能**调用 `replace_file_content` 进行精准的局部块级替换（diff）。严禁大面积重写或无意义整文件覆盖。
  - **严禁通过命令写文件**: **绝对禁止**使用终端命令行（包括 `run_command`、PowerShell、bash、`node -e`、`python -c`、`echo`、`cat <<EOF`、重定向符 `>` / `>>`、文件系统 API 脚本等）直接修改、创建或写入项目源码、配置与数据文件。
  - **透明可审查**: 所有代码变动必须具备明确的 diff 记录，以便用户随时审查与回滚。
