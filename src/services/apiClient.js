import { getToken } from "./authService";

export async function fetchSignature() {
  const auth = getToken();
  const res = await fetch(process.env.REACT_APP_API_BASE_URL + "/api/signature", {
    headers:{
      "Authorization":"Bearer " + auth.token,
      "X-Auth-Type": auth.type
    }
  });
  return res.json();
}
