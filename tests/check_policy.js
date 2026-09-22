const fs = require('fs');

if (process.argv.length !== 3) {
    throw new Error('usage: node check_policy.js MODEL.json');
}

require('../app/policy.js');
const model = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const policy = new globalThis.SafeSabrPolicy(model);
let maxLogitError = 0;
for (const vector of model.test_vectors) {
    const result = policy.predict(vector.observation);
    if (result.action !== vector.action) {
        throw new Error(`action mismatch: JS=${result.action} Python=${vector.action}`);
    }
    result.logits.forEach((value, index) => {
        maxLogitError = Math.max(maxLogitError, Math.abs(value - vector.logits[index]));
    });
}
console.log(JSON.stringify({
    vectors: model.test_vectors.length,
    action_matches: model.test_vectors.length,
    max_logit_error: maxLogitError,
}));
