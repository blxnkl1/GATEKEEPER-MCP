---
name: Bug report
about: Something decided wrongly, or failed to start
labels: bug
body:
  - type: markdown
    attributes:
      value: |
        Thanks for the report. The decision and the evidence behind it are the
        most useful things you can provide, so please include both.

  - type: input
    id: agent
    attributes:
      label: Agent and version
      placeholder: "OpenCode v2.0.18, Claude Code 2.1.195, Hermes 0.17.0, Codex ..."
    validations:
      required: true

  - type: dropdown
    id: os
    attributes:
      label: Operating system
      options:
        - macOS
        - Linux
        - Windows
        - Other
    validations:
      required: true

  - type: input
    id: node
    attributes:
      label: Node version
      placeholder: "v20.20.0"
    validations:
      required: true

  - type: input
    id: install
    attributes:
      label: How did you install it
      placeholder: "npm install -g gatekeeper-mcp / npx / clone and build"
    validations:
      required: true

  - type: textarea
    id: call
    attributes:
      label: The exact pre_action_check input
      description: |
        The arguments you passed. Redact absolute paths and any secrets; a
        plausible path is enough to reproduce.
      render: json
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: Expected decision
      description: Which decision you expected, and why.
    validations:
      required: true

  - type: textarea
    id: actual
    attributes:
      label: Actual decision
      description: |
        Paste the whole response, including the `evidence` and `state` objects.
        Those show what the engine actually observed.
      render: json
    validations:
      required: true

  - type: textarea
    id: reproduce
    attributes:
      label: Steps to reproduce
      description: What you ran, in order.
    validations:
      required: true

  - type: textarea
    id: stderr
    attributes:
      label: Server stderr, if you have it
      description: |
        Run the server by hand and paste stderr. Logs go to stderr because
        stdout is the JSON-RPC channel. Set PINO_LOG_LEVEL=debug for more.
      render: shell
