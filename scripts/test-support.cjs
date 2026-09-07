const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Compile isolated modules with the project's compiler, without starting
// Electron. Callers supply replacements for side-effectful native/UI services.
function loadSource(relativePath, overrides = {}) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(filename), name);
      return loadSource(fs.existsSync(`${target}.ts`) ? `${target}.ts` : `${target}.tsx`, overrides);
    }
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

module.exports = { loadSource };
