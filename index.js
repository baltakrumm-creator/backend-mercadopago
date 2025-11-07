// index.js (completo y corregido)

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

// ✅ CONFIGURAR MERCADO PAGO (wrapper que usabas)
const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN,
});

// Utilidad: URL pública donde Mercado Pago DEBE notificar tu webhook.
// En producción pon la URL pública (ej: https://mi-backend.onrender.com/webhook)
// En local deja undefined o usa http://localhost:3000/webhook (pero para pruebas reales MP necesita URL pública)
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

        // Desestructurar datos
        const { title, quantity = 1, price, formData } = req.body;

        // Validar datos básicos
        if (!title || price == null || !formData) {
            console.error("⚠️ Faltan datos necesarios:", { title, price, formData });
            return res.status(400).json({ error: "Datos incompletos para crear la preferencia." });
        }

        // Asegurar que el precio sea numérico
        const numericPrice = Number(price);
        if (isNaN(numericPrice)) {
            console.error("❌ Precio no numérico recibido:", price);
            return res.status(400).json({ error: "El precio debe ser un número válido." });
        }

        // Limpiar país si viene como objeto (react-select)
        const cleanForm = {
            ...formData,
            pais:
                formData.pais && typeof formData.pais === "object"
                    ? formData.pais.label
                    : formData.pais,
        };

        // External reference para vincular pagos con pedidos temporales
        const externalReference = `ref-${Date.now()}`;

        console.log("🧾 Creando preferencia con:", {
            title,
            quantity: Number(quantity),
            unit_price: numericPrice,
            external_reference: externalReference,
        });

        // Crear preferencia usando el SDK que estás usando (Preference)
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [
                    {
                        title,
                        quantity: Number(quantity),
                        unit_price: numericPrice,
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
                // IMPORTANTE: notificar al webhook correcto
                notification_url: "https://backend-mercadopago-e4he.onrender.com/webhook",
            },
        });

        // Manejar distintas formas en que el SDK puede devolver la preferencia
        const prefId = result?.response?.id ?? result?.id ?? result?.body?.id;
        const initPoint = result?.response?.init_point ?? result?.sandbox_init_point ?? result?.init_point ?? result?.sandbox_init_point ?? result?.body?.init_point;

        if (!prefId) {
            console.error("❌ No se pudo obtener el id de la preferencia desde la respuesta de MP:", result);
            return res.status(500).json({ error: "No se pudo obtener la preferencia de Mercado Pago." });
        }

        console.log("✅ Preferencia creada correctamente:", prefId);

        // Guardar pedido temporal en la base de datos
        const sql = `
  INSERT INTO pedidos_temporales 
  (preference_id, external_reference, nombre, apellido, email, documento, direccion, provincia, ciudad, codigo_postal, celular, tipo_envio, empresa_envio)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;


        const values = [
            prefId,
            externalReference,
            cleanForm.nombre,
            cleanForm.apellido,
            cleanForm.email,
            cleanForm.documento, // 👈 agregado
            `${cleanForm.calle || ""} ${cleanForm.numero || ""}`.trim(),
            cleanForm.provincia,
            cleanForm.ciudad,
            cleanForm.codigoPostal,
            cleanForm.celular,
            cleanForm.tipoEnvio,
            cleanForm.empresaEnvio,
        ];


        db.query(sql, values, (err) => {
            if (err) {
                console.error("❌ Error al guardar pedido temporal:", err);
            } else {
                console.log("🟢 Pedido temporal guardado correctamente en la base de datos.");
            }
        });

        // Responder al frontend con el init_point (link de pago)
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
            raw: String(error),
        });
    }
});

// =========================
// ✅ WEBHOOK: Mercado Pago avisa el estado del pago
// =========================
app.post("/webhook", async (req, res) => {
    try {
        // Log completo (para depurar qué envia MP)
        console.log("🔔 Webhook recibido - body:", req.body, "query:", req.query, "headers:", req.headers);

        const event = req.body;

        // MercadoPago puede enviar distintos objetos. Si viene type/data.id:
        const isPaymentNotification = event?.type === "payment" && event?.data?.id;
        // A veces MP puede mandar topic / id por query params (IPN)
        const paymentIdFromQuery = req.query?.id || req.query?.payment_id || null;
        const paymentId = isPaymentNotification ? event.data.id : paymentIdFromQuery;

        if (!paymentId) {
            console.warn("⚠️ Webhook recibido sin payment id. Ignorando.");
            // responder 200 para evitar reintentos innecesarios
            return res.sendStatus(200);
        }

        // Consultar API de MP para detalles del pago
        const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        });

        const data = await mpResponse.json();
        console.log("📦 Detalle del pago obtenido desde MP:", data);

        // Solo procesar si está aprobado
        if (data?.status === "approved") {
            console.log("💰 Pago aprobado:", data.id, "external_reference:", data.external_reference);

            // Buscar el pedido temporal por external_reference
            db.query(
                "SELECT * FROM pedidos_temporales WHERE external_reference = ?",
                [data.external_reference],
                (err, results) => {
                    if (err) {
                        console.error("❌ Error al buscar pedido temporal:", err);
                        return;
                    }

                    if (!results || results.length === 0) {
                        console.warn("⚠️ No se encontró el pedido temporal para:", data.external_reference);
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
                        pedido.documento, // 👈 agregado
                        pedido.direccion,
                        pedido.provincia,
                        pedido.ciudad,
                        pedido.codigo_postal,
                        pedido.celular,
                        pedido.tipo_envio,
                        pedido.empresa_envio,
                        data.transaction_amount ?? data.total_paid_amount ?? data.transaction_amounts?.[0] ?? 0,
                        data.status,
                    ];


                    db.query(sqlInsert, valuesInsert, (err2) => {
                        if (err2) {
                            console.error("❌ Error al guardar pedido confirmado:", err2);
                        } else {
                            console.log("✅ Pedido confirmado guardado correctamente");

                            // Borrar pedido temporal
                            db.query("DELETE FROM pedidos_temporales WHERE external_reference = ?", [data.external_reference], (err3) => {
                                if (err3) console.error("❌ Error al borrar pedido temporal:", err3);
                                else console.log("🗑️ Pedido temporal eliminado:", data.external_reference);
                            });
                        }
                    });
                }
            );
        } else {
            console.log("ℹ️ Estado del pago no aprobado (o distinto):", data.status);
        }

        // Responder 200 siempre para evitar reintentos (si no hay error interno)
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
