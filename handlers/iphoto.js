// Handler for iPhoto / Apple Photos libraries
// TODO: implement

function detect(sourceDir) {
    // iPhoto libraries contain an "AlbumData.xml" at the root
    // Apple Photos libraries contain a "database/Photos.sqlite"
    const fs = require('fs');
    const path = require('path');
    if (fs.existsSync(path.join(sourceDir, 'AlbumData.xml'))) return true;
    if (fs.existsSync(path.join(sourceDir, 'database', 'Photos.sqlite'))) return true;
    return false;
}

async function generate(sourceDir, outputLibPath, progressCallback) {
    throw new Error('iPhoto / Apple Photos import is not yet implemented.');
}

module.exports = { generate, detect };
