# pipr owns PR runtime, Pi owns agent execution

pipr owns GitHub event handling, configuration, workflow orchestration, diff manifests, output validation, and comment publishing. Pi is the only agent runner and is invoked behind a narrow adapter because GitHub PR semantics, validation, and publishing policy must stay deterministic and product-owned while Pi remains focused on agent execution.
