import axios from "axios";

export const API = axios.create({
  baseURL: "/",          // ✅ REQUIRED
  headers: {
    Accept: "application/json", // ✅ VERY IMPORTANT
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
