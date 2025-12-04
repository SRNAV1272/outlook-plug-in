import React, { useState } from "react";
import {
  Button,
  TextField,
  Typography,
  Box,
  Paper,
  CircularProgress
} from "@mui/material";

export default function LoginForm({ onLogin, loading = false, error }) {
  const [form, setForm] = useState({ username: "", password: "" });

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onLogin(form);
  };

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        bgcolor: "#f5f7fb"
      }}
    >
      <Paper
        elevation={4}
        sx={{
          width: "100%",
          maxWidth: 360,
          p: 3,
          borderRadius: 3
        }}
      >
        <Typography variant="h6" mb={1} textAlign="center">
          Cardbyte Sign In
        </Typography>

        <Typography variant="body2" color="text.secondary" textAlign="center" mb={2}>
          Sign in to sync your email signature
        </Typography>

        {error && (
          <Typography color="error" variant="body2" textAlign="center" mb={2}>
            {error}
          </Typography>
        )}

        <form onSubmit={handleSubmit}>
          <TextField
            fullWidth
            size="small"
            margin="dense"
            label="Username"
            name="username"
            value={form.username}
            onChange={handleChange}
            autoFocus
            required
          />

          <TextField
            fullWidth
            size="small"
            margin="dense"
            label="Password"
            name="password"
            type="password"
            value={form.password}
            onChange={handleChange}
            required
          />

          <Button
            fullWidth
            variant="contained"
            type="submit"
            disabled={loading}
            sx={{ mt: 2, borderRadius: 2 }}
          >
            {loading ? <CircularProgress size={22} color="inherit" /> : "Sign in"}
          </Button>
        </form>
      </Paper>
    </Box>
  );
}
