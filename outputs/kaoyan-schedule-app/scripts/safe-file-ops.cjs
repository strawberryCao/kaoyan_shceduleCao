const fs = require('fs');

/**
 * Delete one file if it exists.
 *
 * Do not replace this with fs.rmSync(file, { force: true }). On the Windows
 * desktop environment used by this app that call can return without removing
 * the file, which leaves stale locks and transaction artifacts behind.
 */
function unlinkFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = { unlinkFileIfExists };
