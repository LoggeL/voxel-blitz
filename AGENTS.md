# UI design workflow

For substantial visual UI changes, first use ImageGen to create a few design
alternatives based on the current game UI and the requested behavior. Choose
the best fitting design, implement it in the existing HTML/CSS/JavaScript,
and compare actual browser screenshots against the chosen reference.

Save the generated references and prompts under `docs/design/`, and verify
the implemented UI at desktop and mobile sizes. Keep all gameplay rules and
displayed values tied to the authoritative game state.
