import React from "react";
import {
  Grid,
  Box,
  Button,
  Typography,
  Paper,
  Divider,
  Stack
} from "@mui/material";
import PreviewEmailSignatureInAlert from "./SignatureComponents/EmailSignature";
import { card, form } from "./dataset";

export default function SignatureView({ html, apply, refresh }) {
  return (
    <Grid container justifyContent="center" alignItems="center" style={{ minHeight: "100vh", backgroundColor: "#f5f7fb" }}>
      <Grid
        item
        size={{
          xs: 12,
          sm: 8,
          md: 6,
          lg: 6
        }}
      >
        <Paper
          elevation={4}
          sx={{
            borderRadius: 3,
            p: 2,
            bgcolor: "#ffffff",
            border: "1px solid #e0e0e0"
          }}
        >
          <PreviewEmailSignatureInAlert
            form={form}
            Card={card}
            apply={apply}
          />
          <Divider sx={{ mb: 1.5 }} />
        </Paper>
      </Grid>
    </Grid>
  );
}
