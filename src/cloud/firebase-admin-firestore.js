// Stub: Firebase Firestore bridge (not required for Electron desktop app)
module.exports = {
    startupCheck: async (opts = {}) => ({
        success: true,
        configured: false,
        required: opts.required || false,
        message: 'Skipped (desktop app, no Firestore required)',
        probe: opts.probe || false
    })
};
