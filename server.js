const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const EfiPay = require('gn-api-sdk-node');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const serviceAccount = require('./firebase-key.json');
const path = require('path');
require('dotenv').config();

initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://rifa-patinente-default-rtdb.firebaseio.com"
});
const db = getDatabase();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 1. Rota para Gerar o Pix Dinâmico na Efí
app.post('/api/pix/create', async (req, res) => {
    // Adicionado o 'cpf' na desestruturação dos dados recebidos do frontend
    const { name, phone, cpf, numbers, amount } = req.body;

    const options = {
        sandbox: false,
        client_id: 'Client_Id_e86c98373d0df5d676379f5faf496ded71decb1a',
        client_secret: 'Client_Secret_100f5fe98b5f037f05bc9366afc7be023ae69b59',
        certificate: path.join(__dirname, 'certificado/producao-963471-Vakinha-da-Sorte.p12')
    };

    const efipay = new EfiPay(options);

    const body = {
        calendario: {
            expiracao: 600
        },
        devedor: {
            nome: name,
            cpf: cpf ? cpf.replace(/\D/g, '') : '' // Formata o CPF removendo pontos e traços exigidos pela Efí
        },
        valor: {
            original: parseFloat(amount).toFixed(2)
        },
        chave: 'e208d04b-f284-43bb-848a-1115c16ae4c3',
        solicitacaoPagador: `Doação Rifas - Cotas: ${numbers.join(', ')}`
    };

    try {
        const pix = await efipay.pixCreateImmediateCharge([], body);
        const qrCode = await efipay.pixGenerateQRCode({ id: pix.loc.id });

        await db.ref(`transactions/${pix.txid}`).set({
            numbers: numbers,
            buyer: { name, phone, cpf },
            amount: amount,
            status: 'PENDING',
            createdAt: new Date().toISOString()
        });

        res.json({
            success: true,
            txid: pix.txid,
            qrcode_image: qrCode.imagemQrcode,
            qrcode_code: qrCode.qrcode
        });
    } catch (error) {
        console.error("Erro ao gerar Pix na Efí:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Webhook para receber a confirmação automática de pagamento da Efí
app.post('/api/pix/webhook', async (req, res) => {
    const pixEvents = req.body.pix;

    if (pixEvents) {
        for (const event of pixEvents) {
            const txid = event.txid;
            const txSnap = await db.ref(`transactions/${txid}`).once('value');
            const txData = txSnap.val();

            if (txData && txData.numbers) {
                for (const num of txData.numbers) {
                    await db.ref(`tickets/${num}`).set({
                        status: 'paid',
                        updatedAt: new Date().toISOString(),
                        buyer: txData.buyer,
                        confirmedBy: 'EFI_AUTO'
                    });
                }
                await db.ref(`transactions/${txid}/status`).set('PAID');
            }
        }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de liquidação Efí rodando na porta ${PORT}`));