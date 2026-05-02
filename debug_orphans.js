const sql = require('mssql');
const fs = require('fs');
const ini = require('ini');
const path = require('path');

const configData = ini.parse(fs.readFileSync('config.ini', 'utf-8'));
const config = {
    user: configData.database.user,
    password: configData.database.password,
    server: configData.database.server,
    database: configData.database.database,
    options: { encrypt: false, trustServerCertificate: true },
    port: parseInt(configData.database.port, 10) || 1433
};

async function checkOrphans() {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request().query(`
            SELECT DISTINCT FuelTypeCode 
            FROM D17_DailySale 
            WHERE FuelTypeCode NOT IN (SELECT FuelTypeCode FROM D1_FuelType)
        `);
        console.log('Orphaned FuelTypeCodes:', result.recordset);
        await sql.close();
    } catch (err) {
        console.error(err);
    }
}
checkOrphans();
