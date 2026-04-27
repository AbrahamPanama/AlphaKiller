import React, { useState } from "react";
import { KeyRound, X } from "lucide-react";

export function SettingsPanel({
  models,
  selectedModel,
  refineDefault,
  briaPreserveAlpha,
  disabled,
  refineAvailable,
  hasWebGpu,
  hasElectronBackgroundRemoval,
  tokenValue,
  onModelChange,
  onRefineDefaultChange,
  onBriaPreserveAlphaChange,
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
        <p className="settings-hint">Use RMBG-1.4 first. BEN2 is the backup. BRIA 2.0 is experimental until its edge quality is proven on AlphaKiller artwork.</p>
        <div className="model-options" role="radiogroup" aria-label="Background removal model">
          {Object.entries(models).map(([id, model]) => {
            const modelDisabled = disabled ||
              (model.requiresWebGpu && !hasWebGpu) ||
              (model.requiresElectron && !hasElectronBackgroundRemoval);
            const unavailableMessage = model.requiresWebGpu && !hasWebGpu
              ? "Unavailable: WebGPU is not available in this browser."
              : model.requiresElectron && !hasElectronBackgroundRemoval
                ? "Unavailable: open the Electron app to use this provider."
                : model.notice;
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
                  <strong>{model.label}{model.badge ? <b>{model.badge}</b> : null}</strong>
                  <small>{model.description}</small>
                  <em>{unavailableMessage}</em>
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
            checked={briaPreserveAlpha}
            disabled={disabled}
            onChange={(event) => onBriaPreserveAlphaChange(event.target.checked)}
          />
          <span>
            <strong>Preserve existing alpha for BRIA</strong>
            <small>Turn off to let RMBG-2.0 rebuild the alpha instead of keeping source transparency.</small>
          </span>
        </label>
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
        <label className="settings-label" htmlFor="bria-token-input">BRIA API token</label>
        <p className="settings-hint">Optional local override for Experimental BRIA 2.0. The safer production path is launching Electron with BRIA_API_TOKEN.</p>
        <div className="token-row">
          <KeyRound size={14} />
          <input
            id="bria-token-input"
            type="password"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder="Optional BRIA API token"
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
