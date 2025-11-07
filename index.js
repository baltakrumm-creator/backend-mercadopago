// index.js (versión completa y mejorada)

// ✅ DEPENDENCIAS
import express from "express";
import cors from "cors";
import mysql from "mysql2";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MercadoPagoConfig, Preference } from "mercadopago";

dotenv.config();
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ✅ CONEXIÓN A MYSQL (POOL)
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Test conexión
db.getConnection((err, connection) => {
    if (err) console.error("❌ Error al conectar a MySQL:", err);
    else {
        console.log("✅ Conexión a MySQL establecida correctamente");
        connection.release();
    }
});

// ✅ CONFIGURAR MERCADO PAGO
const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN,
});

const webhookUrl = process.env.WEBHOOK_URL || `http://localhost:${port}/webhook`;

// 🧩 Ruta de prueba
app.get("/", (req, res) => {
    res.send("Servidor funcionando correctamente ✅");
});

// =========================
// ✅ Crear preferencia y guardar pedido temporal
// =========================
app.post("/create_preference", async (req, res) => {
    try {
        console.log("📩 Body recibido:", req.body);

        const { title, quantity = 1, price, formData, products } = req.body;

        if (!title || price == null || !formData) {
            console.error("⚠️ Faltan datos necesarios:", { title, price, formData });
            return res.status(400).json({ error: "Datos incompletos para crear la preferencia." });
        }

        const numericPrice = Number(price);
        if (isNaN(numericPrice)) {
            console.error("❌ Precio no numérico recibido:", price);
            return res.status(400).json({ error: "El precio debe ser un número válido." });
        }

        const cleanForm = {
            ...formData,
            pais:
                formData.pais && typeof formData.pais === "object"
                    ? formData.pais.label
                    : formData.pais,
        };

        const externalReference = `ref-${Date.now()}`;

        console.log("🧾 Creando preferencia con:", {
            title,
            quantity: Number(quantity),
            unit_price: numericPrice,
            external_reference: externalReference,
        });

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

        const prefId = result?.response?.id ?? result?.id ?? result?.body?.id;
        const initPoint = result?.response?.init_point || result?.init_point || result?.body?.init_point;

        if (!prefId) {
            console.error("❌ No se pudo obtener el id de la preferencia:", result);
            return res.status(500).json({ error: "No se pudo obtener la preferencia de Mercado Pago." });
        }

        console.log("✅ Preferencia creada correctamente:", prefId);

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
            else console.log("🟢 Pedido temporal guardado correctamente.");
        });

        // Guardar productos temporales (si existen)
        if (products && Array.isArray(products)) {
            const sqlProductos = `
                INSERT INTO productos_temporales 
                (external_reference, name_product, price, img, quantity, size, color)
                VALUES ?
            `;
            const valuesProductos = products.map((p) => [
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
                else console.log("🟢 Productos temporales guardados correctamente.");
            });
        }

        return res.json({
            init_point: initPoint,
            preference_id: prefId,
            external_reference: externalReference,
        });
    } catch (error) {
        console.error("❌ Error al crear la preferencia:", error);
        return res.status(500).json({
            error: "Error al crear la preferencia",
            message: error.message,
        });
    }
});

// =========================
// ✅ WEBHOOK: Mercado Pago avisa el estado del pago
// =========================
app.post("/webhook", async (req, res) => {
    try {
        console.log("🔔 Webhook recibido - body:", req.body, "query:", req.query);

        const event = req.body;
        const isPaymentNotification = event?.type === "payment" && event?.data?.id;
        const paymentIdFromQuery = req.query?.id || req.query?.payment_id || null;
        const paymentId = isPaymentNotification ? event.data.id : paymentIdFromQuery;

        if (!paymentId) {
            console.warn("⚠️ Webhook sin payment id. Ignorando.");
            return res.sendStatus(200);
        }

        const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                "Content-Type": "application/json",
            },
        });

        const data = await mpResponse.json();
        console.log("📦 Detalle del pago desde MP:", data);

        if (data?.status === "approved") {
            console.log("💰 Pago aprobado:", data.id, "external_reference:", data.external_reference);

            db.query(
                "SELECT * FROM pedidos_temporales WHERE external_reference = ?",
                [data.external_reference],
                (err, results) => {
                    if (err) {
                        console.error("❌ Error al buscar pedido temporal:", err);
                        return;
                    }

                    if (!results.length) {
                        console.warn("⚠️ No se encontró el pedido temporal:", data.external_reference);
                        return;
                    }

                    const pedido = results[0];

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
                        if (err2) {
                            console.error("❌ Error al guardar pedido confirmado:", err2);
                            return;
                        }

                        console.log("✅ Pedido confirmado guardado correctamente.");
                        const pedidoId = resultInsert.insertId;

                        // Guardar productos asociados
                        db.query(
                            "SELECT * FROM productos_temporales WHERE external_reference = ?",
                            [data.external_reference],
                            (err4, productos) => {
                                if (err4) {
                                    console.error("❌ Error al obtener productos temporales:", err4);
                                    return;
                                }

                                if (productos.length > 0) {
                                    const sqlInsertProductos = `
                                        INSERT INTO productos_pedidos_confirmados 
                                        (pedido_id, name_product, price, img, quantity, size, color)
                                        VALUES ?
                                    `;
                                    const valuesProdInsert = productos.map((p) => [
                                        pedidoId,
                                        p.name_product,
                                        p.price,
                                        p.img,
                                        p.quantity,
                                        p.size,
                                        p.color,
                                    ]);

                                    db.query(sqlInsertProductos, [valuesProdInsert], (err5) => {
                                        if (err5)
                                            console.error("❌ Error al mover productos confirmados:", err5);
                                        else console.log("🟢 Productos confirmados guardados correctamente.");
                                    });
                                }

                                // Borrar datos temporales
                                db.query("DELETE FROM pedidos_temporales WHERE external_reference = ?", [data.external_reference]);
                                db.query("DELETE FROM productos_temporales WHERE external_reference = ?", [data.external_reference]);
                            }
                        );
                    });
                }
            );
        } else {
            console.log("ℹ️ Pago no aprobado:", data.status);
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error en webhook:", error);
        return res.sendStatus(500);
    }
});

// ✅ Iniciar servidor
app.listen(port, () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
    console.log(`🔔 Webhook URL configurada en: ${webhookUrl}`);
});
