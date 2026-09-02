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
  photoroomTokenValue,
  briaTokenValue,
  onModelChange,
  onRefineDefaultChange,
  onBriaPreserveAlphaChange,
  onPhotoroomTokenSave,
  onBriaTokenSave,
  onClose
}) {
  const [photoroomTokenDraft, setPhotoroomTokenDraft] = useState(photoroomTokenValue || "");
  const [briaTokenDraft, setBriaTokenDraft] = useState(briaTokenValue || "");

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
        <p className="settings-hint">PhotoRoom is the new hosted option. Local models and BRIA remain available for comparison.</p>
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

      {selectedModel === "bria-api" && <section className="settings-section">
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
      </section>}

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
        <span className="settings-label">API credentials</span>
        <p className="settings-hint">Stored only in this Electron browser profile. Environment variables remain the safer production option.</p>
        <ApiTokenField
          id="photoroom-token-input"
          label="PhotoRoom API key"
          hint="Used by the PhotoRoom API background-removal provider. Environment variable: PHOTOROOM_API_KEY."
          value={photoroomTokenDraft}
          placeholder="PhotoRoom API key"
          onChange={setPhotoroomTokenDraft}
          onSave={onPhotoroomTokenSave}
        />
        <ApiTokenField
          id="bria-token-input"
          label="BRIA API token"
          hint="Used by BRIA background removal and Super Scale. Environment variable: BRIA_API_TOKEN."
          value={briaTokenDraft}
          placeholder="BRIA API token"
          onChange={setBriaTokenDraft}
          onSave={onBriaTokenSave}
        />
      </section>
    </div>
  );
}

function ApiTokenField({ id, label, hint, value, placeholder, onChange, onSave }) {
  return (
    <div className="credential-field">
      <label className="credential-label" htmlFor={id}>{label}</label>
      <p className="settings-hint">{hint}</p>
      <div className="token-row">
        <KeyRound size={14} />
        <input
          id={id}
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" onClick={() => onSave(value)}>Save</button>
      </div>
      <button className="text-button" type="button" onClick={() => {
        onChange("");
        onSave("");
      }}>
        Clear stored key
      </button>
    </div>
  );
}
