const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
app.use(cors()); // Flutter မှ ချိတ်ဆက်နိုင်ရန်
app.use(express.json());

// MSSQL Connection Configuration
const config = {
    user: 'sa',
    password: 'infosys2011iss@',
    server: '43.242.135.98', // သို့မဟုတ် IP Address
    database: 'M001',
    options: {
        encrypt: false, // SSL ပိတ်ထားခြင်း
        trustServerCertificate: true
    },
    port: 1433
};

app.get('/api/eho/send-count', async (req, res) => {
    let pool = await sql.connect(config);
    let result = await pool.request().query(`
                SELECT COUNT(*) AS COUNT FROM [dbo].[D17_DailySale] WHERE [HO] = '0'
            `);
    res.json(result.recordset);
});

// sys_control ကို date range ဖြင့် ရှာဖွေသည့် API
app.get('/api/system-control/search', async (req, res) => {
    try {
        const { start, end } = req.query; // Flutter မှ ?start=...&end=... ပုံစံဖြင့် ပို့ရမည်

        let pool = await sql.connect(config);
        let result = await pool.request()
            .input('startTime', sql.DateTime, start) // DateTime အဖြစ် သတ်မှတ်
            .input('endTime', sql.DateTime, end)
            .query(`
                SELECT [Sdate], [soption], [HO] 
                FROM [dbo].[sys_control]
                WHERE [Sdate] BETWEEN @startTime AND @endTime
                ORDER BY [Sdate] DESC
            `);

        res.json(result.recordset);
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).send(err.message);
    }
});

// index.js ထဲက Query နေရာမှာ အစားထိုးရန်
app.get('/api/sales/recent', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request().query(`
                SELECT TOP (20) S.[VocNo], S.[S_Date], S.[Vehical_No], 
                       S.[SALELITER], S.[TotalPrice], T.[Sale_Type_name], F.[FuelTypeName],
                       P.[Price] AS TodayPrice
                FROM [dbo].[D17_DailySale] AS S
                LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                OUTER APPLY (
                    SELECT TOP 1 Price 
                    FROM D16_PetrolPrice 
                    WHERE FuelTypeCode = s.FuelTypeCode 
                    ORDER BY S_Date DESC, PID DESC
                ) p
                ORDER BY S.[S_Date] DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ရက်စွဲအလိုက် ရှာဖွေသည့် API
// index.js
app.get('/api/sales/search', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let pool = await sql.connect(config);

        let result = await pool.request()
            .input('start', sql.DateTime, startDate) // DateTime အဖြစ် လက်ခံ
            .input('end', sql.DateTime, endDate)
            .query(`
                SELECT S.[VocNo], S.[S_Date], S.[Vehical_No], 
                       S.[SALELITER], S.[TotalPrice], T.[Sale_Type_name], F.[FuelTypeName],
                       P.[Price] AS TodayPrice
                FROM [dbo].[D17_DailySale] AS S
                LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                OUTER APPLY (
                    SELECT TOP 1 Price 
                    FROM D16_PetrolPrice 
                    WHERE FuelTypeCode = s.FuelTypeCode 
                    ORDER BY S_Date DESC, PID DESC
                ) p
                WHERE S.[S_Date] BETWEEN @start AND @end
                ORDER BY S.[S_Date] DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Server စတင်ခြင်း
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`API Server running on http://localhost:${PORT}`);
});