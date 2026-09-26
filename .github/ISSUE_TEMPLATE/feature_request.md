---
name: Feature request
about: Suggest a change in behaviour
labels: enhancement
body:
  - type: markdown
    attributes:
      value: |
        This project is deliberately small. Requests are easier to accept when
        they explain what breaks without the change, so please describe the
        situation rather than the solution.

  - type: dropdown
    id: phase
    attributes:
      label: Which phase does this belong to
      description: See docs/phases.md for what each phase covers.
      options:
        - Phase 1 - MVP (shipped)
        - Phase 2 - Real engine (shipped)
        - Phase 3 - Agent integration (shipped)
        - Phase 4 - Distribution (shipped)
        - Phase 5 - Hardening (planned)
        - Not phase-specific
    validations:
      required: true

  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve
      description: |
        What goes wrong today, and for whom. A concrete situation is worth more
        than a feature description.
    validations:
      required: true

  - type: textarea
    id: proposal
    attributes:
      label: What you would like to happen instead
    validations:
      required: true

  - type: dropdown
    id: constraint
    attributes:
      label: Does this need a new runtime dependency
      description: |
        The project is local-only with no network calls and no runtime
        dependencies beyond the MCP SDK, zod, and pino. Please say how to do it
        without adding one if you can.
      options:
        - "No, it can be done with what is already there"
        - "Yes, and I have thought about the trade-off"
        - "Not sure"
    validations:
      required: true

  - type: dropdown
    id: security
    attributes:
      label: Does this weaken a safety guarantee
      description: |
        The reproduction commands an agent supplies are run without a shell, in a
        working directory confined to the repository, with a timeout and capped
        output. Requests that touch these need careful review.
      options:
        - "No"
        - "Yes, and I have explained why below"
        - "Not sure"
    validations:
      required: true
