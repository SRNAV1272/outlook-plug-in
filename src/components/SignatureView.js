import React from "react";
import {
  Grid,
  Box,
  Paper,
  Divider,
  Stack,
  Button,
  Typography
} from "@mui/material";

export default function SignatureView({ apply }) {

  // ✅ FULL SIGNATURE HTML — KEEP IT AS-IS
  const signatureHTML = `
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial, sans-serif; max-width:600px;">

  <tr>
    <td colspan="2">
      <img 
        src="https://cardbyteqasg.blob.core.windows.net/cardbyte-email-signature/5badb545-d26c-4c83-aee2-a49070be7792.png"
        width="400"
        style="display:block;border:1px solid #ccc;border-radius:10px;"
      />
    </td>
  </tr>

  <tr>
    <td colspan="2" style="padding-top:8px;">
      <a href="https://www.instagram.com/___vive_k/" target="_blank">
        <img src="https://cardbyteqasg.blob.core.windows.net/cardbyte-social-media-assets/instagram.png" width="30" />
      </a>
      <a href="https://www.youtube.com/@cardbyte317" target="_blank">
        <img src="https://cardbyteqasg.blob.core.windows.net/cardbyte-social-media-assets/youtube.png" width="30" />
      </a>
    </td>
  </tr>

  <tr>
    <td colspan="2" style="padding-top:12px;">
      <a href="https://calendly.com/johndoe/30min" target="_blank"
         style="font-family:Arial;font-size:14px;border:1px solid #000;padding:8px 16px;text-decoration:none;">
        Book A Meeting
      </a>
    </td>
  </tr>

  <tr>
    <td colspan="2" style="padding-top:12px;">
      <img
        src="https://cardbyteqasg.blob.core.windows.net/cardbyte-email-signature/Banner-CB-ORG-1106202526817349-93132"
        width="400"
      />
    </td>
  </tr>

  <tr>
    <td colspan="2" style="padding-top:12px;font-size:11px;color:#666;">
      This e-mail and any attachments are confidential.
    </td>
  </tr>

</table>
`;

  return (
    <Grid
      container
      justifyContent="center"
      alignItems="center"
      sx={{ minHeight: "100vh", backgroundColor: "#f5f7fb" }}
    >
      <Grid item xs={12} sm={8} md={6} lg={6}>
        <Paper sx={{ p: 2, borderRadius: 3 }}>

          {/* ✅ SAFE PREVIEW (IMAGE ONLY) */}
          <Box textAlign="center">
            <Typography fontSize={13} color="text.secondary" mb={1}>
              Signature Preview
            </Typography>

            <img
              src="/signature-preview.png"
              width="400"
              alt="Preview"
              style={{ border: "1px solid #ccc", borderRadius: 8 }}
            />
          </Box>

          <Divider sx={{ my: 2 }} />
        </Paper>

        {/* ✅ APPLY — FULL HTML GOES HERE */}
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 2 }}>
          <Button
            onClick={() => apply(signatureHTML)}
            variant="outlined"
          >
            Apply
          </Button>
        </Stack>
      </Grid>
    </Grid>
  );
}