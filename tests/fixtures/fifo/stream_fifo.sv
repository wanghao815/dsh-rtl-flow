// Verification fixture only. Generic ready/valid FIFO; no array or arithmetic pipeline.
// No empty bypass. Full + pop permits push in the same cycle. Synchronous active-low reset.
module stream_fifo #(
  parameter int WIDTH = 8,
  parameter int DEPTH = 3,
  localparam int PW = (DEPTH <= 1) ? 1 : $clog2(DEPTH),
  localparam int CW = $clog2(DEPTH + 1)
) (
  input logic clk, rst_n,
  input logic in_valid,
  output logic in_ready,
  input logic [WIDTH-1:0] in_data,
  output logic out_valid,
  input logic out_ready,
  output logic [WIDTH-1:0] out_data
);
  logic [WIDTH-1:0] mem [0:DEPTH-1];
  logic [PW-1:0] rp, wp;
  logic [CW-1:0] count;
  logic push, pop;
  assign out_valid = (count != 0);
  assign out_data = mem[rp];
  assign pop = out_valid && out_ready;
  assign in_ready = (count < CW'(DEPTH)) || pop;
  assign push = in_valid && in_ready;

  always_ff @(posedge clk) begin
    if (!rst_n) begin
      rp <= '0;
      wp <= '0;
      count <= '0;
    end else begin
      if (push) begin
        mem[wp] <= in_data;
        wp <= (wp == PW'(DEPTH-1)) ? '0 : wp + 1'b1;
      end
      if (pop) rp <= (rp == PW'(DEPTH-1)) ? '0 : rp + 1'b1;
      case ({push, pop})
        2'b10: count <= count + 1'b1;
        2'b01: count <= count - 1'b1;
        default: count <= count;
      endcase
    end
  end
endmodule
