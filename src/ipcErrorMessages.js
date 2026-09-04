export function unwrapElectronIpcError(message = "", channel = "") {
  let unwrapped = String(message || "").trim();
  const invokeMatch = unwrapped.match(/^Error invoking remote method ['"]([^'"]+)['"]:\s*/i);

  if (invokeMatch && (!channel || invokeMatch[1] === channel)) {
    unwrapped = unwrapped.slice(invokeMatch[0].length).trim();
  }

  while (/^Error:\s*/i.test(unwrapped)) {
    unwrapped = unwrapped.replace(/^Error:\s*/i, "").trim();
  }

  return unwrapped;
}

export function getBgRemoveErrorMessage(message = "") {
  const unwrapped = unwrapElectronIpcError(message, "background-removal:run");
  const lower = unwrapped.toLowerCase();

  if (lower.includes("no handler registered")) {
    return "Electron needs to be restarted so the background-removal IPC handler is registered.";
  }

  if (lower.includes("photoroom")) {
    if (lower.includes("missing photoroom_api_key")) {
      return "Missing PhotoRoom API key. Add it in Settings or launch Electron with PHOTOROOM_API_KEY set.";
    }
    if (
      (lower.includes("key") && (lower.includes("rejected") || lower.includes("access"))) ||
      lower.includes("401") ||
      lower.includes("403")
    ) {
      return "The PhotoRoom API key was rejected. Check the key and the account's API access.";
    }
    if (
      lower.includes("credit") ||
      lower.includes("quota") ||
      lower.includes("payment") ||
      lower.includes("402")
    ) {
      return "The PhotoRoom API quota is exhausted or billing is required. Check the PhotoRoom account usage.";
    }
    if (
      lower.includes("6,000") ||
      lower.includes("36 megapixels") ||
      lower.includes("50 mb") ||
      lower.includes("too large") ||
      lower.includes("413")
    ) {
      return "PhotoRoom accepts files up to 50 MB and 6,000 pixels on the longest side. Use a smaller source image.";
    }
    if (lower.includes("format") || lower.includes("invalid png") || lower.includes("415")) {
      return "PhotoRoom rejected the input or output format. AlphaKiller requires a full-resolution PNG response.";
    }
    if (lower.includes("rate limit") || lower.includes("429")) {
      return "The PhotoRoom API is rate limited. Wait a moment and try again.";
    }
    if (
      lower.includes("temporarily unavailable") ||
      lower.includes("fetch failed") ||
      lower.includes("network") ||
      /http 5\d\d/.test(lower)
    ) {
      return "PhotoRoom is temporarily unavailable or could not be reached. Check your connection and try again.";
    }

    return stripProviderPrefix(unwrapped, "photoroom-api") || "PhotoRoom background removal failed.";
  }

  if (lower.includes("bria")) {
    if (lower.includes("missing bria_api_token")) {
      return "Missing BRIA_API_TOKEN. Launch the Electron app with BRIA_API_TOKEN set in the main-process environment.";
    }
    if (lower.includes("token") || lower.includes("401") || lower.includes("403")) {
      return "The BRIA API token was rejected. Check BRIA_API_TOKEN and the account's API access.";
    }
    if (lower.includes("415") || lower.includes("png")) {
      return "BRIA rejected the input image format. AlphaKiller expected a normalized PNG upload.";
    }
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "The background-removal provider is rate limited. Wait a moment and try again.";
  }
  if (lower.includes("no hugging face token")) {
    return "No Hugging Face token is available to AlphaKiller. In Electron, launch with HF_TOKEN set. In the browser preview, set localStorage key alphakiller:hf-token.";
  }
  if (lower.includes("token was rejected")) {
    return "The Hugging Face token was rejected for the background-removal model. Make sure the token was created by the account that has model access and includes read permission.";
  }
  if (
    lower.includes("restricted") ||
    lower.includes("unauthorized") ||
    lower.includes("authorization") ||
    lower.includes("authenticate") ||
    lower.includes("gated") ||
    lower.includes("access to model") ||
    lower.includes("401") ||
    lower.includes("rmbg-2.0")
  ) {
    return "The background-removal model is restricted on Hugging Face. Accept the model license and authenticate before retrying.";
  }
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("download")) {
    return "Could not download the background removal model. Check your connection and try again.";
  }
  if (lower.includes("memory") || lower.includes("allocation") || lower.includes("out of")) {
    return "Image too large for background removal at full resolution.";
  }
  if (lower.includes("corrupt") || lower.includes("invalid model")) {
    return "The cached background removal model appears to be invalid. Try clearing the app cache and retrying.";
  }
  return unwrapped || "Background removal failed.";
}

export function getSuperScaleErrorMessage(message = "") {
  const unwrapped = unwrapElectronIpcError(message, "super-scale:run");
  const lower = unwrapped.toLowerCase();

  if (lower.includes("no handler registered")) {
    return "Electron needs to be restarted so the Super Scale IPC handler is registered.";
  }
  if (lower.includes("missing bria")) {
    return "Missing BRIA_API_TOKEN. Add a BRIA token in Settings or launch Electron with BRIA_API_TOKEN set.";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("token")) {
    return "The BRIA API token was rejected. Check the token and account access.";
  }
  if (lower.includes("8192")) {
    return "BRIA Super Scale supports output up to 8192 x 8192 pixels. Try 2x or start from a smaller image.";
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "The BRIA API is rate limited. Wait a moment and try again.";
  }
  if (lower.includes("format") || lower.includes("415")) {
    return "BRIA rejected the input image format. AlphaKiller expected a normalized PNG upload.";
  }
  return unwrapped || "Super Scale failed.";
}

function stripProviderPrefix(message, provider) {
  return message.replace(new RegExp(`^\\[?${provider}\\]?:?\\s*`, "i"), "").trim();
}
