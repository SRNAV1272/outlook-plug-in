import axios from "axios";
const API_BASE_URL =
  process.env.NODE_ENV === "development"
    ? "" // proxy handles it
    : ""; // PROD backend

export const API = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    Accept: "application/json",
  },
});


API.interceptors.request.use(
  async (req) => {
    req.headers = {
      ...req.headers,
      "Content-Type": "application/json",
      username: localStorage.getItem("encryptedEmail"),
    };
    return req;
  },
  (error) => Promise.reject(error)
);

export const emailsigOutlook = () =>
  API.get("/email-signature/outlook/get-active");
