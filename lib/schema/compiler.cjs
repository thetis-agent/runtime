/** Generated lazy dynamic-schema compiler; ADR 0037. Do not edit. */
module.exports = function create(documents) { const { Ajv2020 } = require("ajv/dist/2020.js"); const instance = new Ajv2020({ strict: false, strictNumbers: true, allErrors: false, validateFormats: false, inlineRefs: false }); for (const document of documents) instance.addSchema(document); return instance; };
