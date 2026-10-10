// Keep synchronous WASM solving off the UI thread.
importScripts('./dist/clingcon-demo.js');

// Clingo's JSON output is printed incrementally. Extract each object in the
// Witnesses array so the UI can use solutions before the full search ends.
function witnessStream(onWitness) {
  let inWitnesses = false;
  let collecting = false;
  let json = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  return (line) => {
    const chunk = `${line}\n`;
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index];
      if (!inWitnesses) {
        const marker = chunk.indexOf('"Witnesses"', index);
        if (marker < 0) return;
        const opening = chunk.indexOf('[', marker);
        if (opening < 0) return;
        inWitnesses = true;
        index = opening;
        continue;
      }
      if (!collecting) {
        if (character === ']') { inWitnesses = false; continue; }
        if (character !== '{') continue;
        collecting = true;
        json = '';
        depth = 0;
        inString = false;
        escaped = false;
      }
      json += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{') depth++;
      else if (character === '}') depth--;
      if (collecting && depth === 0) {
        collecting = false;
        onWitness(JSON.parse(json));
        json = '';
      }
    }
  };
}

self.onmessage = async ({ data }) => {
  const outputLimit = 256 * 1024;
  const batchSize = 250;
  const batchInterval = 500;
  let stdout = '';
  let stdoutTruncated = false;
  let stderr = '';
  let stderrTruncated = false;
  let resultName = '';
  let more = '';
  let pending = [];
  let lastFlush = performance.now();
  const appendLimited = (current, line, truncated) => {
    if (truncated) return [current, true];
    const addition = `${current ? '\n' : ''}${line}`;
    if (current.length + addition.length <= outputLimit) return [current + addition, false];
    return [`${current}\n\n... デバッグ出力は ${outputLimit / 1024} KiB で省略しました ...`, true];
  };
  const flush = () => {
    if (!pending.length) return;
    self.postMessage({ progress: pending });
    pending = [];
    lastFlush = performance.now();
  };
  try {
    const acceptLine = witnessStream((witness) => {
      pending.push(witness);
      if (pending.length >= batchSize || performance.now() - lastFlush >= batchInterval) flush();
    });
    const module = await createClingconDemo({
      noInitialRun: true,
      print: (line) => {
        line = String(line);
        [stdout, stdoutTruncated] = appendLimited(stdout, line, stdoutTruncated);
        acceptLine(line);
        const resultMatch = /"Result"\s*:\s*"([^"]+)"/.exec(line);
        const moreMatch = /"More"\s*:\s*"([^"]+)"/.exec(line);
        if (resultMatch) resultName = resultMatch[1];
        if (moreMatch) more = moreMatch[1];
      },
      printErr: (line) => {
        [stderr, stderrTruncated] = appendLimited(stderr, String(line), stderrTruncated);
      },
    });
    const exitCode = module.ccall('clingcon_run', 'number', ['string', 'string'], [data.program, data.options]);
    flush();
    self.postMessage({ exitCode, stdout, stderr, resultName, more, streamed: true });
  } catch (error) {
    flush();
    self.postMessage({ error: error.message || String(error), stdout, stderr, resultName, more, streamed: true });
  }
};
