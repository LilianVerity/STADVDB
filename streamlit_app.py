import streamlit as st
import pandas as pd

st.title("STADVDB MCO1 (WIP)")

st.write("Table hehe")
st.write(pd.DataFrame({
    'first column': [1, 2, 3, 4],
    'second column': [10, 20, 30, 40]
}))
