// Library generator — detects the source type and delegates to the appropriate handler.
// Add new source types by creating a handler in ./handlers/ and registering it below.

const iMovieEvents = require('./handlers/imovie-events');
const iPhoto       = require('./handlers/iphoto');
const standard     = require('./handlers/standard');

// Handlers are checked in order — first match wins
const HANDLERS = [
    { name: 'imovie_events', handler: iMovieEvents },
    { name: 'iphoto',        handler: iPhoto       },
    { name: 'standard',      handler: standard     }, // always matches
];

function detectSourceType(sourceDir) {
    for (const { name, handler } of HANDLERS) {
        if (!handler.detect || handler.detect(sourceDir)) return name;
    }
    return 'standard';
}

async function generateLibrary(sourceDir, outputLibPath, progressCallback) {
    const type    = detectSourceType(sourceDir);
    const { handler } = HANDLERS.find(h => h.name === type);
    console.log(`[library-generator] source type: ${type}`);
    return handler.generate(sourceDir, outputLibPath, progressCallback);
}

module.exports = { generateLibrary, detectSourceType };
