const axios = require('axios');

async function test() {
    try {
        const response = await axios.get('http://localhost:3000/api/reports/stock-ledger', {
            params: {
                startDate: '2026-03-27',
                endDate: '2026-03-28',
                stationId: 'M001'
            }
        });
        console.log(JSON.stringify(response.data[0], null, 2));
    } catch (error) {
        console.error(error.message);
    }
}

test();
