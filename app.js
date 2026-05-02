const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const fs = require('fs');
const ini = require('ini');
const path = require('path');
const ModbusRTU = require('modbus-serial');

const app = express();
app.use(cors()); // Flutter မှ ချိတ်ဆက်နိုင်ရန်
app.use(express.json());

// Load Config from config.ini
const configFilePath = path.join(__dirname, 'config.ini');
const configData = ini.parse(fs.readFileSync(configFilePath, 'utf-8'));

// MSSQL Connection Configuration
const baseConfig = {
    user: configData.database.user,
    password: configData.database.password,
    server: configData.database.server,
    options: {
        encrypt: false, // SSL ပိတ်ထားခြင်း
        trustServerCertificate: true,
        connectionTimeout: 60000,
        requestTimeout: 60000
    },
    port: parseInt(configData.database.port, 10) || 1433
};

const pools = new Map();

const getDbConfig = (req) => {
    // Priority: query param > header > config.ini
    let dbName = req.query.stationId || req.headers['x-station-id'] || configData.database.database;

    return { ...baseConfig, database: dbName };
};

const getPool = async (req) => {
    const config = getDbConfig(req);
    const key = config.database;
    if (pools.has(key)) {
        return pools.get(key);
    }
    const pool = new sql.ConnectionPool(config);
    const connectedPool = await pool.connect();
    pools.set(key, connectedPool);
    return connectedPool;
};

app.get('/api/eho/send-count', async (req, res) => {
    let pool = await getPool(req);
    let result = await pool.request().query(`
                SELECT COUNT(*) AS COUNT FROM [dbo].[D17_DailySale] WHERE [HO] = '0'
            `);
    res.json(result.recordset);
});
// health-check route
app.get('/api/health', async (req, res) => {
    try {
        // ၁။ Database Connection ကို စစ်မယ်
        let pool = await getPool(req);

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
        let pool = await getPool(req);
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
        let pool = await getPool(req);
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
        let pool = await getPool(req);
        let result = await pool.request()
            .input('startTime', sql.VarChar, start) // VarChar အဖြစ် ပြောင်းလဲ (Timezone shift မဖြစ်စေရန်)
            .input('endTime', sql.VarChar, end)
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
        let pool = await getPool(req);
        let result = await pool.request().query(`
                SELECT 
                        S.[VocNo], S.[S_Date], S.[Vehical_No],
                        C.[cate_name] AS Category,
                        S.[SALELITER], S.[TotalPrice], ISNULL(NULLIF(F.[FuelTypeName], ''), T.[Sale_Type_name]) AS FuelTypeName,
                        T.[Sale_Type_name],
                        (SELECT TOP 1 Price FROM [dbo].[D16_PetrolPrice] P 
                        WHERE P.FuelTypeCode = S.FuelTypeCode 
                        ORDER BY P.S_Date DESC, P.PID DESC) AS TodayPrice,
                        H.[NZ_label] AS Nozzle,
                        S.[Pump_No] AS Pump,
                        D.[Pump_Name] AS PumpName,
                        S.[Hose_Meter_Volume] AS MeterVolume,
                        S.[Hose_Meter_Value] AS MeterValue,
                        S.[Pump_Staff] AS CashierName,
                        CT.[Counter_Name] AS SaleCounter,
                        S.[SaleGallon], S.[discount], S.[tax_value] AS AfterTax,
                        ISNULL(E.[e_Payment_name], '') AS ePayment 
                    FROM (
                        -- အရင်ဆုံး Row ၂၀ ကိုပဲ သီးသန့် အရင်ဆွဲထုတ်တယ် (ဒါက အမြန်ဆုံးပဲ)
                        SELECT TOP (10) * FROM [dbo].[D17_DailySale] WITH (NOLOCK)
                        ORDER BY [S_Date] DESC, [VocNo] DESC
                    ) AS S
                    LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                    LEFT JOIN [dbo].[D99_Category] AS C ON S.Currency_Code = C.cate_code
                    LEFT JOIN [dbo].[D10_Hose] AS H ON S.Hose_ID = H.Hose_ID
                    LEFT JOIN [dbo].[D10_Pump] AS D ON S.Pump_No = D.Pump_No
                    LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                    LEFT JOIN [dbo].[D7_Counter] AS CT ON S.Counter_Code = CT.Counter_Code
                    LEFT JOIN [dbo].[D17_Sale_e_Payment] AS EP ON S.VocNo = EP.VocNo 
                        AND T.[Sale_Type_name] = 'ePayment'
                    LEFT JOIN [dbo].[D14_e_Payment] AS E ON EP.e_Payment_ID = E.e_Payment_ID;
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

        let pool = await getPool(req);

        let result = await pool.request()
            .input('start', sql.VarChar, startDate) // VarChar အဖြစ် ပြောင်းလဲ (Timezone shift မဖြစ်စေရန်)
            .input('end', sql.VarChar, endDate)
            .query(`
                SELECT 
                        S.[VocNo], S.[S_Date], S.[Vehical_No],
                        C.[cate_name] AS Category,
                        S.[SALELITER], S.[TotalPrice], ISNULL(NULLIF(F.[FuelTypeName], ''), T.[Sale_Type_name]) AS FuelTypeName,
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
                        ISNULL(E.[e_Payment_name], '') AS ePayment 
                    FROM (
                        -- အဆင့် (၁) - သတ်မှတ်ထားတဲ့ ရက်စွဲအတွင်းက Row တွေကိုပဲ အရင်စစ်ထုတ်မယ်
                        SELECT * FROM [dbo].[D17_DailySale] WITH (NOLOCK)
                        WHERE [S_Date] BETWEEN @start AND @end
                    ) AS S
                    -- အဆင့် (၂) - စျေးနှုန်းကို Cross Apply နဲ့ အမြန်ဆုံးဆွဲမယ်
                    CROSS APPLY (
                        SELECT TOP 1 Price 
                        FROM [dbo].[D16_PetrolPrice] AS P 
                        WHERE P.FuelTypeCode = S.FuelTypeCode 
                        AND P.S_Date <= S.S_Date
                        ORDER BY P.S_Date DESC, P.PID DESC
                    ) AS LP
                    -- အဆင့် (၃) - လိုအပ်တဲ့ Table အသေးလေးတွေကိုမှ နောက်ဆုံးမှ Join မယ်
                    LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                    LEFT JOIN [dbo].[D99_Category] AS C ON S.Currency_Code = C.cate_code
                    LEFT JOIN [dbo].[D10_Hose] AS H ON S.Hose_ID = H.Hose_ID
                    LEFT JOIN [dbo].[D10_Pump] AS D ON S.Pump_No = D.Pump_No
                    LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                    LEFT JOIN [dbo].[D7_Counter] AS CT ON S.Counter_Code = CT.Counter_Code
                    LEFT JOIN [dbo].[D17_Sale_e_Payment] AS EP ON S.VocNo = EP.VocNo 
                        AND T.[Sale_Type_name] = 'ePayment'
                    LEFT JOIN [dbo].[D14_e_Payment] AS E ON EP.e_Payment_ID = E.e_Payment_ID
                    ORDER BY S.[S_Date] DESC, S.[VocNo] DESC;
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

        let pool = await getPool(req);

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
                        S.[SALELITER], S.[TotalPrice], ISNULL(NULLIF(F.[FuelTypeName], ''), T.[Sale_Type_name]) AS FuelTypeName,
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
        let pool = await getPool(req);
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
        let pool = await getPool(req);
        let result = await pool.request()
            .query(`
                SELECT 
                    ISNULL(NULLIF(F.[FuelTypeName], ''), T.[Sale_Type_name]) as label, 
                    SUM(S.[SALELITER]) as value 
                FROM [dbo].[D17_DailySale] AS S WITH (NOLOCK)
                LEFT JOIN [dbo].[D1_FuelType] AS F ON S.FuelTypeCode = F.FuelTypeCode
                LEFT JOIN [dbo].[d14_Saletype] AS T ON S.Sale_Type_ID = T.Sale_Type_ID
                WHERE 
                        S.[S_Date] BETWEEN '2026-02-15 00:00:00' AND '2026-02-16 23:59:59'
                GROUP BY ISNULL(NULLIF(F.[FuelTypeName], ''), T.[Sale_Type_name])
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ၂။ Fuel Sale Summary (Today)
app.get('/api/summary/data', async (req, res) => {
    try {
        let pool = await getPool(req);
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
// Stock Ledger Report API (Manual Calculation)
app.get('/api/reports/stock-ledger', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let pool = await getPool(req);
        console.log(`Manual Stock Calculation: Start=${startDate}, End=${endDate}`);

        // 1. Fetch Tanks
        let tankResult = await pool.request().query('SELECT Tank_No, Tank_Name, FuelTypeCode, Capacity FROM D9_Tank');
        let tanks = tankResult.recordset;

        // 2. Fetch Fuel Types
        let fuelTypeResult = await pool.request().query('SELECT FuelTypeCode, FuelTypeName FROM D1_FuelType');
        let fuelTypes = fuelTypeResult.recordset;

        // 3. Fetch Sales (Grouped simply by Hose_ID and FuelTypeCode to avoid join duplication)
        let salesResult = await pool.request()
            .input('s', sql.VarChar, startDate)
            .input('e', sql.VarChar, endDate)
            .query(`
                SELECT Hose_ID, FuelTypeCode, Sale_Type_ID, SUM(SALELITER) as TotalLiter 
                FROM D17_DailySale 
                WHERE S_Date BETWEEN @s AND @e 
                GROUP BY Hose_ID, FuelTypeCode, Sale_Type_ID
            `);
        let salesRaw = salesResult.recordset;

        // 4. Fetch Hoses for mapping
        let hoseResult = await pool.request().query('SELECT Hose_ID, Tank_No, Pump_No, fueltypecode FROM D10_Hose');
        let hoses = hoseResult.recordset;

        // 5. Fetch Receives
        let receiveResult = await pool.request()
            .input('s', sql.VarChar, startDate)
            .input('e', sql.VarChar, endDate)
            .query(`
                SELECT Tank_No, FuelTypeCode, SUM(R_Gallon * 4.546) as TotalLiter 
                FROM D18_FuelReceive 
                WHERE R_Date BETWEEN @s AND @e 
                GROUP BY Tank_No, FuelTypeCode
            `);
        let receives = receiveResult.recordset;

        // 6. Fetch ALL readings for the range (and some before)
        let balanceResult = await pool.request()
            .input('s', sql.VarChar, startDate)
            .input('e', sql.VarChar, endDate)
            .query(`
                SELECT fueltypecode, TankBalance, d_t_actual, Sdate
                FROM d99_Tank_Actual1 
                WHERE Sdate <= @e
            `);
        let allReadings = balanceResult.recordset;
        
        // Map sales to tanks in JavaScript to handle NULL Hose_IDs
        let reportData = tanks.map(tank => {
            const fuel = fuelTypes.find(f => f.FuelTypeCode === tank.FuelTypeCode) || { FuelTypeName: 'Unknown' };
            const tid = parseInt(tank.FuelTypeCode, 10);

            // Collect sales for this tank
            const tankSalesRaw = salesRaw.filter(sale => {
                const hose = hoses.find(h => h.Hose_ID === sale.Hose_ID);
                if (hose && hose.Tank_No === tank.Tank_No) return true;
                
                // Fallback: If no hose mapping, match by FuelTypeCode for the primary tank
                if (!hose && parseInt(sale.FuelTypeCode, 10) === tid) {
                   const firstTankId = tanks.find(t => parseInt(t.FuelTypeCode, 10) === tid)?.Tank_No;
                   return tank.Tank_No === firstTankId;
                }
                return false;
            });

            const tankReceive = receives.find(r => r.Tank_No === tank.Tank_No);
            
            // Find balances in JS
            const fuelReadings = allReadings.filter(r => parseInt(r.fueltypecode, 10) === tid);
            const openingReading = fuelReadings
                .filter(r => new Date(r.Sdate) <= new Date(startDate))
                .sort((a,b) => new Date(b.Sdate) - new Date(a.Sdate))[0];
                
            const closingReading = fuelReadings
                .filter(r => new Date(r.Sdate) >= new Date(startDate) && new Date(r.Sdate) <= new Date(endDate))
                .sort((a,b) => new Date(b.Sdate) - new Date(a.Sdate))[0];

            // Calculate totals
            let cashSale = tankSalesRaw.filter(s => s.Sale_Type_ID == '1' || s.Sale_Type_ID == 'Cash Sale').reduce((acc, curr) => acc + curr.TotalLiter, 0);
            let creditSale = tankSalesRaw.filter(s => s.Sale_Type_ID == '2' || s.Sale_Type_ID == 'Credit Sale').reduce((acc, curr) => acc + curr.TotalLiter, 0);
            let epaySale = tankSalesRaw.filter(s => s.Sale_Type_ID == 'ePayment' || s.Sale_Type_ID == '4').reduce((acc, curr) => acc + curr.TotalLiter, 0);
            let totalSale = tankSalesRaw.reduce((acc, curr) => acc + curr.TotalLiter, 0);
            let receiveTotal = tankReceive ? tankReceive.TotalLiter : 0;
            let opening = openingReading ? openingReading.TankBalance : 0;
            let actual = closingReading ? closingReading.d_t_actual : 0;

            return {
                Tank_No: tank.Tank_No,
                Tank_Name: tank.Tank_Name,
                FuelTypeCode: tank.FuelTypeCode,
                FuelTypeName: fuel.FuelTypeName,
                opening: opening, 
                received: receiveTotal,
                cash_sale: cashSale,
                credit_sale: creditSale,
                epay_sale: epaySale,
                sale: totalSale,
                closing: opening + receiveTotal - totalSale,
                tankbalance: actual,
                Gain_Mine: actual - (opening + receiveTotal - totalSale)
            };
        });

        res.json(reportData);
    } catch (err) {
        console.error("Manual Calculation Error:", err);
        res.status(500).send(err.message);
    }
});

// Debug: View Procedure Text
app.get('/api/debug/helptext/:proc', async (req, res) => {
    try {
        let pool = await getPool(req);
        let result = await pool.request()
            .input('objname', sql.VarChar, req.params.proc)
            .execute('sp_helptext');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Debug: List All Procedures
app.get('/api/procedures', async (req, res) => {
    try {
        let pool = await getPool(req);
        let result = await pool.request().query("SELECT NAME FROM sys.procedures WHERE name LIKE 'pprd_%'");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Debug: List All Tables
app.get('/api/tables', async (req, res) => {
    try {
        let pool = await getPool(req);
        let result = await pool.request().query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Debug: List All Tanks
app.get('/api/tanks', async (req, res) => {
    try {
        let pool = await getPool(req);
        let result = await pool.request().query('SELECT * FROM D9_Tank');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Debug: Version info
app.get('/api/debug/version', (req, res) => {
    res.json({ version: '2026-03-30 01:20', status: 'Final' });
});

// Debug: View Readings
app.get('/api/debug/readings', async (req, res) => {
    try {
        let pool = await getPool(req);
        let result = await pool.request()
            .query("SELECT TOP 20 * FROM d99_Tank_Actual1 ORDER BY Sdate DESC");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Debug: List Columns of a Table
app.get('/api/debug/columns/:table', async (req, res) => {
    try {
        let pool = await getPool(req);
        let result = await pool.request()
            .input('t', sql.VarChar, req.params.table)
            .query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// --- Sensor Monitoring Logic ---
let sensorData = [];
const sensorConfig = configData.sensor || {};

const decodeFloat = (high, low) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt16BE(high, 0);
    buffer.writeUInt16BE(low, 2);
    return buffer.readFloatBE(0);
};

const pollSensors = async () => {
    if (sensorConfig.enable !== 'on') return;

    const client = new ModbusRTU();
    const ttyPath = sensorConfig.com_port || '/dev/tty.usbserial-10';
    const tankCount = parseInt(sensorConfig.tank_count, 10) || 1;
    const capacities = (sensorConfig.tank_levels || "").split(',').map(v => parseFloat(v.trim()));

    try {
        await client.connectRTUBuffered(ttyPath, { baudRate: 9600 });
        console.log(`Connected to Sensor Modbus on ${ttyPath}`);

        while (true) {
            let currentData = [];
            for (let i = 1; i <= tankCount; i++) {
                try {
                    const tankInfo = sensorConfig[`tank-${i}`] || "";
                    const parts = tankInfo.split(',').map(p => p.trim());
                    const capacity = parseFloat(parts[0]) || 0;
                    const fuelName = parts[1] || 'Unknown';
                    const tankName = parts[2] || `Tank - ${i}`;

                    client.setID(i);
                    const res = await client.readHoldingRegisters(0, 6);
                    
                    const level = decodeFloat(res.data[0], res.data[1]);
                    const water = decodeFloat(res.data[2], res.data[3]);
                    const temp = decodeFloat(res.data[4], res.data[5]);

                    currentData.push({
                        tankNo: i,
                        tankName: tankName,
                        fuelName: fuelName,
                        level: level,
                        water: water,
                        temperature: temp,
                        capacity: capacity,
                        percentage: capacity > 0 ? (level / capacity * 100).toFixed(2) : 0,
                        lastUpdated: new Date().toISOString()
                    });
                } catch (err) {
                    console.error(`Error reading Tank ${i}:`, err.message);
                }
            }
            sensorData = currentData;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (err) {
        console.error("Sensor Modbus connection error:", err.message);
        setTimeout(pollSensors, 5000); // Retry after 5 seconds
    } finally {
        if (client.isOpen) client.close();
    }
};

app.get('/api/sensors', (req, res) => {
    res.json(sensorData);
});

// Server စတင်ခြင်း
const PORT = parseInt(configData.server.port, 10) || 3000;
app.listen(PORT, () => {
    console.log(`API Server running on http://localhost:${PORT}`);
    if (sensorConfig.enable === 'on') {
        pollSensors();
    }
});