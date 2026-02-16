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
// health-check route
app.get('/api/health', async (req, res) => {
    try {
        // ၁။ Database Connection ကို စစ်မယ်
        let pool = await sql.connect(config);

        // ရိုးရိုးရှင်းရှင်း query တစ်ခု စမ်းပစ်ကြည့်မယ်
        await pool.request().query('SELECT 1');

        // ၂။ အားလုံး အိုကေရင် success ပြန်မယ်
        res.status(200).json({
            status: 'online',
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        // ၃။ တစ်ခုခု ချို့ယွင်းရင် (ဥပမာ DB တက်မလာရင်) error ပြန်မယ်
        res.status(500).json({
            status: 'offline',
            database: 'disconnected',
            error: err.message
        });
    }
});

// Fuel Types API
app.get('/api/fueltypes', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request()
            .query('SELECT FuelTypeCode, FuelTypeName, BuyPrice, SalePrice, maincode FROM [D1_FuelType]');

        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});


// Sale Types API
app.get('/api/saletypes', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request()
            .query('SELECT Sale_Type_ID, Sale_Type_name FROM [d14_Saletype]');

        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
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
                ORDER BY [Sdate] ASC
            `);

        res.setHeader('Content-Type', 'application/json');
        res.send(result.recordset);
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
                WITH LatestPrices AS (
                        SELECT FuelTypeCode, Price,
                            ROW_NUMBER() OVER (PARTITION BY FuelTypeCode ORDER BY S_Date DESC, PID DESC) as rn
                        FROM [dbo].[D16_PetrolPrice]
                    )
                    SELECT TOP (20)
                        S.[VocNo], S.[S_Date], S.[Vehical_No],
                        C.[cate_name] AS Category,
                        S.[SALELITER], S.[TotalPrice], F.[FuelTypeName],
                        T.[Sale_Type_name],
                        LP.[Price] AS TodayPrice,
                        H.[NZ_label] AS Nozzle,
                        S.[Pump_No] AS Pump,
                        D.[Pump_Name] AS PumpName,
                        S.[Hose_Meter_Volume] AS MeterVolume,
                        S.[Hose_Meter_Value] AS MeterValue,
                        S.[Pump_Staff] AS CashierName,
                        CT.[Counter_Name] AS SaleCounter,
                        S.[SaleGallon], S.[discount], S.[tax_value] AS AfterTax,
                        -- EP.VocNo နဲ့ မကိုက်ရင် E.e_Payment_name က NULL ဖြစ်နေမှာမလို့ '' ပြောင်းပေးမယ်
                        ISNULL(E.[e_Payment_name], '') AS ePayment 
                    FROM [dbo].[D17_DailySale] AS S WITH (NOLOCK)
                    LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                    LEFT JOIN [dbo].[D99_Category] AS C ON S.Currency_Code = C.cate_code
                    LEFT JOIN [dbo].[D10_Hose] AS H ON S.Hose_ID = H.Hose_ID
                    LEFT JOIN [dbo].[D10_Pump] AS D ON S.Pump_No = D.Pump_No
                    LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                    LEFT JOIN [dbo].[D7_Counter] AS CT ON S.Counter_Code = CT.Counter_Code
                    -- Sale Table နဲ့ Payment Table ကို VocNo နဲ့ ချိတ်မယ်
                    LEFT JOIN [dbo].[D17_Sale_e_Payment] AS EP ON S.VocNo = EP.VocNo AND T.[Sale_Type_name] = 'ePayment'
                    -- EP နဲ့ ချိတ်မိမှသာ Payment Name Table ကို ဆက်ချိတ်မယ်
                    LEFT JOIN [dbo].[D14_e_Payment] AS E ON EP.e_Payment_ID = E.e_Payment_ID
                    LEFT JOIN LatestPrices AS LP ON S.FuelTypeCode = LP.FuelTypeCode AND LP.rn = 1
                    ORDER BY S.[S_Date] DESC;
            `);
        res.setHeader('X-Total-Count', result.recordset.length);
        res.setHeader('Content-Type', 'application/json');
        result.recordset.forEach((row, index) => {
            res.write(JSON.stringify(row) + "\n"); // တစ်ကြောင်းချင်းစီကို Newline နဲ့ ပို့ခြင်း
        });
        res.end();
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
                WITH LatestPrices AS (
                        SELECT FuelTypeCode, Price,
                            ROW_NUMBER() OVER (PARTITION BY FuelTypeCode ORDER BY S_Date DESC, PID DESC) as rn
                        FROM [dbo].[D16_PetrolPrice]
                    )
                    SELECT 
                        S.[VocNo], S.[S_Date], S.[Vehical_No],
                        C.[cate_name] AS Category,
                        S.[SALELITER], S.[TotalPrice], F.[FuelTypeName],
                        T.[Sale_Type_name],
                        LP.[Price] AS TodayPrice,
                        H.[NZ_label] AS Nozzle,
                        S.[Pump_No] AS Pump,
                        D.[Pump_Name] AS PumpName,
                        S.[Hose_Meter_Volume] AS MeterVolume,
                        S.[Hose_Meter_Value] AS MeterValue,
                        S.[Pump_Staff] AS CashierName,
                        CT.[Counter_Name] AS SaleCounter,
                        S.[SaleGallon], S.[discount], S.[tax_value] AS AfterTax,
                        -- EP.VocNo နဲ့ မကိုက်ရင် E.e_Payment_name က NULL ဖြစ်နေမှာမလို့ '' ပြောင်းပေးမယ်
                        ISNULL(E.[e_Payment_name], '') AS ePayment 
                    FROM [dbo].[D17_DailySale] AS S WITH (NOLOCK)
                    LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                    LEFT JOIN [dbo].[D99_Category] AS C ON S.Currency_Code = C.cate_code
                    LEFT JOIN [dbo].[D10_Hose] AS H ON S.Hose_ID = H.Hose_ID
                    LEFT JOIN [dbo].[D10_Pump] AS D ON S.Pump_No = D.Pump_No
                    LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                    LEFT JOIN [dbo].[D7_Counter] AS CT ON S.Counter_Code = CT.Counter_Code
                    -- Sale Table နဲ့ Payment Table ကို VocNo နဲ့ ချိတ်မယ်
                    LEFT JOIN [dbo].[D17_Sale_e_Payment] AS EP ON S.VocNo = EP.VocNo AND T.[Sale_Type_name] = 'ePayment'
                    -- EP နဲ့ ချိတ်မိမှသာ Payment Name Table ကို ဆက်ချိတ်မယ်
                    LEFT JOIN [dbo].[D14_e_Payment] AS E ON EP.e_Payment_ID = E.e_Payment_ID
                    LEFT JOIN LatestPrices AS LP ON S.FuelTypeCode = LP.FuelTypeCode AND LP.rn = 1
                    WHERE S.[S_Date] BETWEEN @start AND @end
                    ORDER BY S.[S_Date] DESC;
            `);
        res.setHeader('X-Total-Count', result.recordset.length);
        res.setHeader('Content-Type', 'application/json');
        result.recordset.forEach((row, index) => {
            res.write(JSON.stringify(row) + "\n"); // တစ်ကြောင်းချင်းစီကို Newline နဲ့ ပို့ခြင်း
        });
        res.end();
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/api/salesdetail/search', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let pool = await sql.connect(config);

        let result = await pool.request()
            .input('start', sql.DateTime, startDate) // DateTime အဖြစ် လက်ခံ
            .input('end', sql.DateTime, endDate)
            .query(`
                    WITH LatestPrices AS (
                        SELECT FuelTypeCode, Price,
                            ROW_NUMBER() OVER (PARTITION BY FuelTypeCode ORDER BY S_Date DESC, PID DESC) as rn
                        FROM [dbo].[D16_PetrolPrice]
                    )
                    SELECT 
                        S.[VocNo], S.[S_Date], S.[Vehical_No],
                        C.[cate_name] AS Category,
                        S.[SALELITER], S.[TotalPrice], F.[FuelTypeName],
                        T.[Sale_Type_name],
                        LP.[Price] AS TodayPrice,
                        H.[NZ_label] AS Nozzle,
                        S.[Pump_No] AS Pump,
                        D.[Pump_Name] AS PumpName,
                        S.[Hose_Meter_Volume] AS MeterVolume,
                        S.[Hose_Meter_Value] AS MeterValue,
                        S.[Pump_Staff] AS CashierName,
                        CT.[Counter_Name] AS SaleCounter,
                        S.[SaleGallon], S.[discount], S.[tax_value] AS AfterTax,
                        -- EP.VocNo နဲ့ မကိုက်ရင် E.e_Payment_name က NULL ဖြစ်နေမှာမလို့ '' ပြောင်းပေးမယ်
                        ISNULL(E.[e_Payment_name], '') AS ePayment 
                    FROM [dbo].[D17_DailySale] AS S WITH (NOLOCK)
                    LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                    LEFT JOIN [dbo].[D99_Category] AS C ON S.Currency_Code = C.cate_code
                    LEFT JOIN [dbo].[D10_Hose] AS H ON S.Hose_ID = H.Hose_ID
                    LEFT JOIN [dbo].[D10_Pump] AS D ON S.Pump_No = D.Pump_No
                    LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                    LEFT JOIN [dbo].[D7_Counter] AS CT ON S.Counter_Code = CT.Counter_Code
                    -- Sale Table နဲ့ Payment Table ကို VocNo နဲ့ ချိတ်မယ်
                    LEFT JOIN [dbo].[D17_Sale_e_Payment] AS EP ON S.VocNo = EP.VocNo AND T.[Sale_Type_name] = 'ePayment'
                    -- EP နဲ့ ချိတ်မိမှသာ Payment Name Table ကို ဆက်ချိတ်မယ်
                    LEFT JOIN [dbo].[D14_e_Payment] AS E ON EP.e_Payment_ID = E.e_Payment_ID
                    LEFT JOIN LatestPrices AS LP ON S.FuelTypeCode = LP.FuelTypeCode AND LP.rn = 1
                    WHERE S.[S_Date] BETWEEN @start AND @end
                    ORDER BY S.[S_Date] DESC;
            `);
        res.setHeader('X-Total-Count', result.recordset.length);
        res.setHeader('Content-Type', 'application/json');
        result.recordset.forEach((row, index) => {
            res.write(JSON.stringify(row) + "\n"); // တစ်ကြောင်းချင်းစီကို Newline နဲ့ ပို့ခြင်း
        });
        res.end();
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/api/summary/saletypes', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request()
            .query(`
                SELECT 
                    T.[Sale_Type_name] as label, 
                    SUM(S.[SALELITER]) as value 
                FROM [dbo].[D17_DailySale] AS S WITH (NOLOCK)
                LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                WHERE 
                        S.[S_Date] BETWEEN '2026-02-15 00:00:00' AND '2026-02-16 23:59:59'
                GROUP BY T.[Sale_Type_name]
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ၂။ Fuel Sale Summary (Today)
app.get('/api/summary/fuelsales', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request()
            .query(`
                SELECT 
                    F.[FuelTypeName] as label, 
                    SUM(S.[SALELITER]) as value 
                FROM [dbo].[D17_DailySale] AS S WITH (NOLOCK)
                LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                WHERE 
                        S.[S_Date] BETWEEN '2026-02-15 00:00:00' AND '2026-02-16 23:59:59'
                GROUP BY F.[FuelTypeName]
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ၂။ Fuel Sale Summary (Today)
app.get('/api/summary/data', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request()
            .query(`
                SELECT 
                    -- ၁။ Total Sale Amount
                    ISNULL(SUM(TotalPrice), 0) as totalAmount,
                    -- ၂။ Total Sale Liter
                    ISNULL(SUM(SALELITER), 0) as totalLiter,
                    -- ၃။ Transaction Count (Total Rewards card အတွက် သုံးနိုင်တယ်)
                    COUNT(VocNo) as totalTransactions
                FROM [dbo].[D17_DailySale] WITH (NOLOCK)
                WHERE CAST(S_Date AS DATE) = CAST(GETDATE() AS DATE)
            `);

        // တစ်ကြောင်းတည်းပဲ ထွက်မှာမို့လို့ recordset[0] ကို ပို့မယ်
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).send({ error: err.message });
    }
});
// Server စတင်ခြင်း
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`API Server running on http://localhost:${PORT}`);
});