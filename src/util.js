
// const key = process.env.REACT_APP_ENCYPTION_KEY; // process.env.REACT_APP_ENCYPTION_KEY;
// const iv = process.env.REACT_APP_ENCYPTION_IV; // process.env.REACT_APP_ENCYPTION_IV;
const key = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const iv = "3YapeNfJDung7TXxeKXn4g==";

export const handleAesEncrypt = async (plainText, generatedKey) => {
    try {
        const keyBuffer = await window.crypto.subtle.importKey(
            "raw",
            base64ToArrayBuffer(generatedKey || key),
            { name: "AES-CBC", length: 256 },
            false,
            ["encrypt"]
        );

        const encrypted = await window.crypto.subtle.encrypt(
            {
                name: "AES-CBC",
                iv: base64ToArrayBuffer(iv),
            },
            keyBuffer,
            new TextEncoder().encode(plainText)
        );

        const encryptedText = window.btoa(
            String.fromCharCode(...new Uint8Array(encrypted))
        );

        return encryptedText;
    } catch (error) {
        console.error("Error encrypting:", error, key, iv);
        // toast.error("Encryption failed. Please try again.");
        return plainText;
    }
};

export const handleAesDecrypt = async (encryptedText, generatedKey) => {
    try {
        const keyBuffer = await window.crypto.subtle.importKey(
            "raw",
            base64ToArrayBuffer(generatedKey || key),
            { name: "AES-CBC", length: 256 },
            false,
            ["decrypt"]
        );

        const decrypted = await window.crypto.subtle.decrypt(
            {
                name: "AES-CBC",
                iv: base64ToArrayBuffer(iv),
            },
            keyBuffer,
            base64ToArrayBuffer(encryptedText)
        );

        const decryptedText = new TextDecoder().decode(decrypted);

        return decryptedText;
    } catch (error) {
        console.error("Error decrypting: ", encryptedText, error);
        return encryptedText;
    }
};

export const generateSecretKeyFromOrgId = async (organizationId) => {
    try {
        // Predefined salt
        const salt = new Uint8Array([
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
            0x0d, 0x0e, 0x0f, 0x10,
        ]);

        // Concatenate organizationId to the secret key
        const fullSecretKey =
            "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=" + organizationId;

        // Derive key using PBKDF2
        const derivedKey = await window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: salt,
                iterations: 65536,
                hash: "SHA-256",
            },
            await window.crypto.subtle.importKey(
                "raw",
                new TextEncoder().encode(fullSecretKey),
                { name: "PBKDF2" },
                false,
                ["deriveBits", "deriveKey"]
            ),
            { name: "AES-CBC", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
        const keyBuffer = await window.crypto.subtle.exportKey("raw", derivedKey);
        const generatedKeyBase64 = btoa(
            String.fromCharCode(...new Uint8Array(keyBuffer))
        );
        return generatedKeyBase64;
    } catch (error) {
        console.error("Error generating secret key", error);
        throw error;
    }
};

const base64ToArrayBuffer = (base64) => {
    const binaryString = window.atob(base64);
    const arrayBuffer = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
        arrayBuffer[i] = binaryString.charCodeAt(i);
    }

    return arrayBuffer;
};