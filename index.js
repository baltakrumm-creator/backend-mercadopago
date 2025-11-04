// ✅ DEPENDENCIAS
import express from "express";
import cors from "cors";
import mysql from "mysql2";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MercadoPagoConfig, Preference } from "mercadopago";

dotenv.config();
const app = express();
const port = 3000;

// ✅ CONFIGURAR MIDDLEWARES
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ✅ CONEXIÓN A MYSQL DE HOSTINGER
const db = mysql.createConnection({
    host: process.env.DB_HOST, // Ej: 'srv123.main-hosting.eu'
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

db.connect((err) => {
    if (err) {
        console.error("❌ Error al conectar a MySQL:", err);
    } else {
        console.log("✅ Conectado a la base de datos MySQL");
    }
});

// ✅ CONFIGURAR MERCADO PAGO
const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

// 🧩 Ruta de prueba
app.get("/", (req, res) => {
    res.send("Servidor funcionando correctamente ✅");
});

// ✅ Crear preferencia y guardar pedido temporal
app.post("/create_preference", async (req, res) => {
    try {
        const { title, quantity, price, formData } = req.body;

        const preference = new Preference(client);

        const result = await preference.create({
            body: {
                items: [
                    {
                        title,
                        quantity: Number(quantity),
                        unit_price: Number(price),
                        currency_id: "ARS",
                    },
                ],
                auto_return: "approved",
                back_urls: {
                    success: "https://kwsites.site/success",
                    failure: "https://kwsites.site/failure",
                    pending: "https://kwsites.site/pending",
                },
                notification_url: "https://backend-mercadopago-e4he.onrender.com/webhook", // 🔔 WEBHOOK
            },
        });

        // ✅ Guardar el pedido temporalmente en la base de datos
        const sql = `
      INSERT INTO pedidos_temporales 
      (preference_id, nombre, apellido, email, direccion, provincia, ciudad, codigo_postal, celular, tipo_envio, empresa_envio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
        const values = [
            result.id,
            formData.nombre,
            formData.apellido,
            formData.email,
            `${formData.calle} ${formData.numero}`,
            formData.provincia,
            formData.ciudad,
            formData.codigoPostal,
            formData.celular,
            formData.tipoEnvio,
            formData.empresaEnvio,
        ];

        db.query(sql, values, (err) => {
            if (err) console.error("❌ Error al guardar pedido temporal:", err);
            else console.log("🟢 Pedido temporal guardado correctamente");
        });

        res.json({ id: result.id });
    } catch (error) {
        console.error("❌ Error al crear la preferencia:", error);
        res.status(500).json({ error: "Error al crear la preferencia" });
    }
});

// ✅ WEBHOOK: Mercado Pago avisa el estado del pago
app.post("/webhook", async (req, res) => {
    try {
        const payment = req.body;

        if (payment.type === "payment") {
            const response = await fetch(`https://api.mercadopago.com/v1/payments/${payment.data.id}`, {
                headers: {
                    Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                },
            });
            const data = await response.json();

            if (data.status === "approved") {
                console.log("💰 Pago aprobado:", data.id);

                // Buscar el pedido temporal y moverlo a la tabla definitiva
                db.query("SELECT * FROM pedidos_temporales WHERE preference_id = ?", [data.order.id], (err, results) => {
                    if (err) return console.error("❌ Error al buscar pedido temporal:", err);

                    if (results.length > 0) {
                        const pedido = results[0];

                        const sql = `
              INSERT INTO pedidos_confirmados 
              (nombre, apellido, email, direccion, provincia, ciudad, codigo_postal, celular, tipo_envio, empresa_envio, monto_total, estado_pago)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
                        const values = [
                            pedido.nombre,
                            pedido.apellido,
                            pedido.email,
                            pedido.direccion,
                            pedido.provincia,
                            pedido.ciudad,
                            pedido.codigo_postal,
                            pedido.celular,
                            pedido.tipo_envio,
                            pedido.empresa_envio,
                            data.transaction_amount,
                            data.status,
                        ];

                        db.query(sql, values, (err) => {
                            if (err) return console.error("❌ Error al guardar pedido confirmado:", err);
                            console.log("✅ Pedido confirmado guardado correctamente");

                            // Borrar pedido temporal
                            db.query("DELETE FROM pedidos_temporales WHERE preference_id = ?", [data.order.id]);
                        });
                    }
                });
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error en webhook:", error);
        res.sendStatus(500);
    }
});

// ✅ Iniciar servidor
app.listen(port, () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
});
