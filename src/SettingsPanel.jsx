import React, { useState } from "react";
import { KeyRound, X } from "lucide-react";

export function SettingsPanel({
  models,
  selectedModel,
  refineDefault,
  disabled,
  refineAvailable,
  hasWebGpu,
  tokenValue,
  onModelChange,
  onRefineDefaultChange,
  onTokenSave,
  onClose
}) {
  const [tokenDraft, setTokenDraft] = useState(tokenValue || "");

  return (
    <div className="settings-popover" role="dialog" aria-label="Settings">
      <div className="settings-head">
        <strong>Settings</strong>
        <button className="icon-button" type="button" aria-label="Close settings" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <section className="settings-section">
        <span className="settings-label">Background model</span>
        <div className="model-options" role="radiogroup" aria-label="Background removal model">
          {Object.entries(models).map(([id, model]) => {
            const modelDisabled = disabled || (model.requiresWebGpu && !hasWebGpu);
            return (
              <label key={id} className={`model-option ${selectedModel === id ? "selected" : ""} ${modelDisabled ? "disabled" : ""}`}>
                <input
                  type="radio"
                  name="bg-remove-model"
                  value={id}
                  checked={selectedModel === id}
                  disabled={modelDisabled}
                  onChange={() => onModelChange(id)}
                />
                <span>
                  <strong>{model.label}</strong>
                  <small>{model.description}</small>
                  <em>{model.requiresWebGpu && !hasWebGpu ? "Unavailable: WebGPU is not available in this browser." : model.notice}</em>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="settings-section">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={refineDefault}
            disabled={disabled || !refineAvailable}
            onChange={(event) => onRefineDefaultChange(event.target.checked)}
          />
          <span>
            <strong>High-quality edges by default</strong>
            <small>{refineAvailable ? "Runs the matting refinement stage after the selected model." : "Unavailable until a browser-ready matting ONNX model is added."}</small>
          </span>
        </label>
      </section>

      <section className="settings-section">
        <label className="settings-label" htmlFor="hf-token-input">Hugging Face token</label>
        <div className="token-row">
          <KeyRound size={14} />
          <input
            id="hf-token-input"
            type="password"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder="Optional development token"
            spellCheck={false}
          />
          <button type="button" onClick={() => onTokenSave(tokenDraft)}>
            Save
          </button>
        </div>
        <button className="text-button" type="button" onClick={() => {
          setTokenDraft("");
          onTokenSave("");
        }}>
          Clear stored token
        </button>
      </section>
    </div>
  );
}
