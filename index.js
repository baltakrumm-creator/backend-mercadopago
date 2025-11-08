// index.js - Backend completo con envío de mail
import express from "express";
import cors from "cors";
import mysql from "mysql2";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MercadoPagoConfig, Preference } from "mercadopago";
import nodemailer from "nodemailer";

dotenv.config();
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ------------------------
// Conexión a MySQL
// ------------------------
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

db.getConnection((err, connection) => {
    if (err) console.error("❌ Error al conectar a MySQL:", err);
    else {
        console.log("✅ Conexión a MySQL establecida correctamente");
        connection.release();
    }
});

// ------------------------
// Configurar Mercado Pago
// ------------------------
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// ------------------------
// Configurar Nodemailer
// ------------------------
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER, // tu mail
        pass: process.env.EMAIL_PASS, // contraseña o app password
    },
});

// ------------------------
// Rutas
// ------------------------
app.get("/", (req, res) => res.send("Servidor funcionando ✅"));

// ------------------------
// Crear preferencia y guardar pedido temporal
// ------------------------
app.post("/create_preference", async (req, res) => {
    try {
        const { title, quantity = 1, price, formData, products } = req.body;

        if (!title || price == null || !formData) return res.status(400).json({ error: "Datos incompletos" });

        const numericPrice = Number(price);
        if (isNaN(numericPrice)) return res.status(400).json({ error: "Precio inválido" });

        const cleanForm = {
            ...formData,
            pais: formData.pais?.label || formData.pais,
        };

        const externalReference = `ref-${Date.now()}`;
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [
                    {
                        title,
                        quantity: Number(quantity),
                        unit_price: 100,
                        currency_id: "ARS",
                    },
                ],
                external_reference: externalReference,
                auto_return: "approved",
                back_urls: {
                    success: "https://kwsites.site/success",
                    failure: "https://kwsites.site/failure",
                    pending: "https://kwsites.site/pending",
                },
                notification_url: "https://backend-mercadopago-e4he.onrender.com/webhook",
            },
        });

        const prefId = result?.response?.id ?? result?.id;
        const initPoint = result?.response?.init_point ?? result?.init_point;

        // Guardar pedido temporal
        const sqlPedido = `
            INSERT INTO pedidos_temporales 
            (preference_id, external_reference, nombre, apellido, email, documento, direccion, provincia, ciudad, codigo_postal, celular, tipo_envio, empresa_envio)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const valuesPedido = [
            prefId,
            externalReference,
            cleanForm.nombre,
            cleanForm.apellido,
            cleanForm.email,
            cleanForm.documento,
            `${cleanForm.calle || ""} ${cleanForm.numero || ""}`.trim(),
            cleanForm.provincia,
            cleanForm.ciudad,
            cleanForm.codigoPostal,
            cleanForm.celular,
            cleanForm.tipoEnvio,
            cleanForm.empresaEnvio,
        ];
        db.query(sqlPedido, valuesPedido, (err) => {
            if (err) console.error("❌ Error al guardar pedido temporal:", err);
        });

        // Guardar productos temporales
        if (products && Array.isArray(products)) {
            const sqlProductos = `
                INSERT INTO productos_temporales 
                (external_reference, name_product, price, img, quantity, size, color)
                VALUES ?
            `;
            const valuesProductos = products.map(p => [
                externalReference,
                p.nameProduct,
                p.price,
                p.img,
                p.quantity,
                p.size,
                p.color,
            ]);
            db.query(sqlProductos, [valuesProductos], (err) => {
                if (err) console.error("❌ Error al guardar productos temporales:", err);
            });
        }

        return res.json({ init_point: initPoint, preference_id: prefId, external_reference: externalReference });

    } catch (error) {
        console.error("❌ Error al crear la preferencia:", error);
        return res.status(500).json({ error: error.message });
    }
});

// ------------------------
// Webhook Mercado Pago
// ------------------------
app.post("/webhook", async (req, res) => {
    try {
        const event = req.body;
        const isPaymentNotification = event?.type === "payment" && event?.data?.id;
        const paymentId = isPaymentNotification ? event.data.id : req.query?.id || req.query?.payment_id;

        if (!paymentId) return res.sendStatus(200);

        const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                "Content-Type": "application/json",
            },
        });
        const data = await mpResponse.json();

        if (data?.status === "approved") {
            db.query("SELECT * FROM pedidos_temporales WHERE external_reference = ?", [data.external_reference], (err, results) => {
                if (err || !results.length) return;

                const pedido = results[0];

                // Guardar pedido confirmado
                const sqlInsert = `
                    INSERT INTO pedidos_confirmados
                    (nombre, apellido, email, documento, direccion, provincia, ciudad, codigo_postal, celular, tipo_envio, empresa_envio, monto_total, estado_pago)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;
                const valuesInsert = [
                    pedido.nombre,
                    pedido.apellido,
                    pedido.email,
                    pedido.documento,
                    pedido.direccion,
                    pedido.provincia,
                    pedido.ciudad,
                    pedido.codigo_postal,
                    pedido.celular,
                    pedido.tipo_envio,
                    pedido.empresa_envio,
                    data.transaction_amount ?? data.total_paid_amount ?? 0,
                    data.status,
                ];

                db.query(sqlInsert, valuesInsert, (err2, resultInsert) => {
                    if (err2) return console.error(err2);
                    const pedidoId = resultInsert.insertId;

                    // Productos confirmados
                    db.query("SELECT * FROM productos_temporales WHERE external_reference = ?", [data.external_reference], (err4, productos) => {
                        if (err4) return console.error(err4);

                        if (productos.length > 0) {
                            const sqlInsertProductos = `
                                INSERT INTO productos_pedidos_confirmados
                                (pedido_id, name_product, price, img, quantity, size, color)
                                VALUES ?
                            `;
                            const valuesProdInsert = productos.map(p => [
                                pedidoId,
                                p.name_product,
                                p.price,
                                p.img,
                                p.quantity,
                                p.size,
                                p.color,
                            ]);

                            db.query(sqlInsertProductos, [valuesProdInsert], (err5) => {
                                if (err5) console.error(err5);
                                else {
                                    console.log("🟢 Productos confirmados guardados correctamente.");

                                    // --- Enviar mail ---
                                    const mailOptions = {
                                        from: `"Mi Tienda" <${process.env.EMAIL_USER}>`,
                                        to: pedido.email,
                                        subject: "Compra confirmada ✅",
                                        html: `
                                            <h1>Gracias por tu compra, ${pedido.nombre}!</h1>
                                            <p>Tu pedido ha sido confirmado. Aquí están los detalles:</p>
                                            <ul>
                                                ${productos.map(p => `<li>${p.name_product} x ${p.quantity} - $${p.price}</li>`).join('')}
                                            </ul>
                                            <p>Monto total: $${data.transaction_amount ?? data.total_paid_amount}</p>
                                            <p>Dirección de envío: ${pedido.direccion}, ${pedido.ciudad}, ${pedido.provincia}</p>
                                        `,
                                    };

                                    transporter.sendMail(mailOptions, (errMail, info) => {
                                        if (errMail) console.error("❌ Error al enviar mail:", errMail);
                                        else console.log("📧 Mail enviado correctamente:", info.response);
                                    });
                                }
                            });
                        }

                        // Borrar temporales
                        db.query("DELETE FROM pedidos_temporales WHERE external_reference = ?", [data.external_reference]);
                        db.query("DELETE FROM productos_temporales WHERE external_reference = ?", [data.external_reference]);
                    });
                });
            });
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error en webhook:", error);
        return res.sendStatus(500);
    }
});

// ------------------------
// Iniciar servidor
// ------------------------
app.listen(port, () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
    console.log(`🔔 Webhook URL configurada: /webhook`);
});
