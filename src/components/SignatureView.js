import React from "react";
import {
  Grid,
  Box,
  Paper,
  Divider,
  Stack,
  Button
} from "@mui/material";

export default function SignatureView({ apply }) {

  // ✅ MUST be a STRING
  const signatureHTML = `
      <table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial, sans-serif; max-width:600px;">

        <tr>
          <td colspan="2">
            <img 
              src="https://cardbyteqasg.blob.core.windows.net/cardbyte-email-signature/5badb545-d26c-4c83-aee2-a49070be7792.png?v=1765629834839"
              alt="Signature"
              width="400"
              style="display:block;border:1px solid #ccc;border-radius:10px;"
            />
          </td>
        </tr>

        <tr>
          <td colspan="2" style="padding-top:8px;">
            <a href="https://www.instagram.com/___vive_k/" target="_blank">
              <img src="https://cardbyteqasg.blob.core.windows.net/cardbyte-social-media-assets/instagram.png" width="30" style="border:0;margin-right:6px;" />
            </a>
            <a href="https://www.youtube.com/@cardbyte317" target="_blank">
              <img src="https://cardbyteqasg.blob.core.windows.net/cardbyte-social-media-assets/youtube.png" width="30" style="border:0;" />
            </a>
          </td>
        </tr>

        <tr>
          <td colspan="2" style="padding-top: 12px; white-space:nowrap;">
            <a 
              href="https://calendly.com/johndoe/30min" 
              target="_blank"
              style="
                background:#fff;
                padding:10px 20px;
                border-radius:20px;
                border:1px solid #000;
                color:#000;
                font-family:Arial, sans-serif;
                font-size:14px;
                font-weight:500;
                text-decoration:none;
                display:inline-flex;
                align-items:center;
                justify-content:center;
                column-gap:6px;
                margin-right:10px;
              "
            >
              <img src="https://cardbyteqasg.blob.core.windows.net/cardbyte-social-media-assets/calendly.png" width="16" style="vertical-align:middle; margin-right:6px;" />
              Book A Meeting
            </a> 
            </td>
        </tr>

        <tr>
          <td colspan="2" style="padding-top:12px;">
            <img
              src="https://cardbyteqasg.blob.core.windows.net/cardbyte-email-signature/Banner-CB-ORG-1106202526817349-93132"
              width="400"
              style="display:block;border:0;"
            />
          </td>
        </tr>

        <tr>
          <td colspan="2" style="padding-top:12px;font-size:11px;color:#666;line-height:1.4;">
            This e-mail and any attachments https://enterprise.cardbyte.ai<br/>
            are confidential. If you are not the intended recipient, please delete it immediately.
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
        <Paper
          elevation={4}
          sx={{
            borderRadius: 3,
            p: 2,
            bgcolor: "#ffffff",
            border: "1px solid #e0e0e0"
          }}
        >
          {/* ✅ Preview */}
          <Box sx={{ display: "flex", justifyContent: "center" }}>
            <Box
              sx={{ maxWidth: 600 }}
              dangerouslySetInnerHTML={{ __html: signatureHTML }}
            />
          </Box>

          <Divider sx={{ my: 1.5 }} />
        </Paper>

        {/* ✅ Apply Button */}
        <Stack spacing={1} direction="row" justifyContent="flex-end" sx={{ mt: 2 }}>
          <Button
            onClick={() => apply(signatureHTML)}
            variant="outlined"
            size="small"
            sx={{
              width: "100px",
              height: "47px",
              borderRadius: "13px",
              fontSize: "13px",
              fontFamily: "Plus Jakarta Display",
              textTransform: "capitalize",
              color: "#4A5056",
              borderColor: "#eeeeee",
              "&:hover": {
                borderColor: "#ccc"
              }
            }}
          >
            Apply
          </Button>
        </Stack>
      </Grid>
    </Grid>
  );
}
