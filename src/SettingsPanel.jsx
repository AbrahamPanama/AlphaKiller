import React, { useState } from "react";
import { KeyRound, RotateCcw, ShieldCheck, X } from "lucide-react";

export function SettingsPanel({
  models,
  selectedModel,
  refineDefault,
  safeguards,
  briaPreserveAlpha,
  disabled,
  refineAvailable,
  hasWebGpu,
  hasElectronBackgroundRemoval,
  tokenValue,
  onModelChange,
  onRefineDefaultChange,
  onSafeguardsChange,
  onSafeguardsReset,
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

      <details className="settings-advanced">
        <summary>
          <span><ShieldCheck size={14} /> Local model safeguards</span>
          <small>Advanced</small>
        </summary>
        <div className="settings-advanced-body">
          <p className="settings-hint">Controls how RMBG-1.4 and BEN2 local detail passes may recover or remove pixels. They do not alter BRIA API output.</p>
          <label className="settings-check compact">
            <input
              type="checkbox"
              checked={safeguards.detailAnalysis}
              disabled={disabled}
              onChange={(event) => onSafeguardsChange({ ...safeguards, detailAnalysis: event.target.checked })}
            />
            <span>
              <strong>Fine-detail boundary analysis</strong>
              <small>Enlarges silhouette crops for hair, lace, jewelry, and narrow branches.</small>
            </span>
          </label>

          <SafeguardRange label="Analysis crop" value={safeguards.detailTileSize} min={384} max={768} step={128} unit=" px" disabled={disabled || !safeguards.detailAnalysis} onChange={(value) => onSafeguardsChange({ ...safeguards, detailTileSize: value })} />
          <SafeguardRange label="Detail pass budget" value={safeguards.maxDetailTiles} min={4} max={48} step={2} unit=" crops" disabled={disabled || !safeguards.detailAnalysis} onChange={(value) => onSafeguardsChange({ ...safeguards, maxDetailTiles: value })} />
          <SafeguardRange label="Subject seed" value={safeguards.seedThreshold} min={4} max={128} disabled={disabled} onChange={(value) => onSafeguardsChange({ ...safeguards, seedThreshold: value })} />
          <SafeguardRange label="Recovery confidence" value={safeguards.detailThreshold} min={4} max={192} disabled={disabled} onChange={(value) => onSafeguardsChange({ ...safeguards, detailThreshold: value })} />
          <SafeguardRange label="Protection starts at" value={safeguards.preserveThreshold} min={Math.min(254, safeguards.seedThreshold + 1)} max={255} disabled={disabled} onChange={(value) => onSafeguardsChange({ ...safeguards, preserveThreshold: value })} />
          <SafeguardRange label="Boundary correction" value={safeguards.edgeBlend} min={0} max={100} unit="%" disabled={disabled} onChange={(value) => onSafeguardsChange({ ...safeguards, edgeBlend: value })} />
          <SafeguardRange label="Recovery reach" value={safeguards.recoveryRadius} min={1} max={96} unit=" px" disabled={disabled} onChange={(value) => onSafeguardsChange({ ...safeguards, recoveryRadius: value })} />

          <label className="settings-check compact">
            <input
              type="checkbox"
              checked={safeguards.matteAwareProtection}
              disabled={disabled}
              onChange={(event) => onSafeguardsChange({ ...safeguards, matteAwareProtection: event.target.checked })}
            />
            <span>
              <strong>Matte-aware protection</strong>
              <small>Lets detail passes contract confident pixels only when they match a border-connected source matte.</small>
            </span>
          </label>
          <SafeguardRange label="Matte color tolerance" value={safeguards.matteTolerance} min={0} max={128} disabled={disabled || !safeguards.matteAwareProtection} onChange={(value) => onSafeguardsChange({ ...safeguards, matteTolerance: value })} />
          <SafeguardRange label="Matte edge depth" value={safeguards.matteBoundaryRadius} min={1} max={24} unit=" px" disabled={disabled || !safeguards.matteAwareProtection} onChange={(value) => onSafeguardsChange({ ...safeguards, matteBoundaryRadius: value })} />

          <button className="text-button settings-reset" type="button" disabled={disabled} onClick={onSafeguardsReset} title="Restore safeguard defaults">
            <RotateCcw size={13} />
            Reset safeguards
          </button>
        </div>
      </details>

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
            <strong>Structure + edges by default</strong>
            <small>{refineAvailable
              ? hasWebGpu
                ? "Uses SAM 3 to protect subject structure, then ViTMatte to refine uncertain edges."
                : "Runs ViTMatte edge refinement; SAM 3 structure locking requires WebGPU."
              : "Unavailable until a browser-ready matting ONNX model is added."}</small>
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

function SafeguardRange({ label, value, min, max, step = 1, unit = "", disabled, onChange }) {
  return (
    <label className="settings-range">
      <span>{label}<output>{value}{unit}</output></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
