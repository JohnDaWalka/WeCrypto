// Stub: Cloud SQL bridge (not required for Electron desktop app)
module.exports = {
    ensureCloudSqlDatabase: async (opts = {}) => ({
        success: true,
        configured: false,
        message: 'Skipped (desktop app, no cloud DB required)'
    }),
    probeCloudSql: async (opts = {}) => ({
        success: true,
        configured: false,
        cached: false,
        instanceState: null,
        databaseExists: null,
        message: 'Skipped (desktop app, no cloud DB required)'
    })
};
