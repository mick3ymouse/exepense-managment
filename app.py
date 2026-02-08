import streamlit as st
import pandas as pd
from streamlit_option_menu import option_menu

# Page config
st.set_page_config(
    page_title="Le mie spese",
    page_icon="💰",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Custom CSS
st.markdown("""
<style>
    /* 1. Hide Toolbars */
    [data-testid="stElementToolbar"] { display: none; }
    
    /* 2. Card Background - Force coloring on containers with borders */
    div[data-testid="stVerticalBlockBorderWrapper"] {
        background-color: #F8FAFC !important; /* Light Slate/Blue */
        border-radius: 12px;
        box-shadow: 0 2px 5px rgba(0,0,0,0.03);
    }
    
    /* Fix internal block background to match or be transparent */
    div[data-testid="stVerticalBlockBorderWrapper"] > div {
        background-color: transparent !important;
    }

    /* 3. Typography & Spacing */
    .card-title {
        font-size: 1.4rem;
        font-weight: 700;
        text-align: center;
        color: #1E293B;
        margin-bottom: 0px !important; /* ZERO margin bottom */
        padding-bottom: 5px;
    }
    
    /* Custom HR style to reduce gap */
    .custom-hr {
        margin-top: 0px !important;
        margin-bottom: 15px !important;
        border: 0;
        border-top: 1px solid #E2E8F0;
    }
    
    /* Metrics Styling */
    div[data-testid="stMetricLabel"] {
        text-align: center;
        width: 100%;
        font-size: 1rem;
        color: #64748B;
    }
    div[data-testid="stMetricValue"] {
        text-align: center;
        width: 100%;
        font-size: 1.8rem !important;
        color: #0F172A;
    }
    
    /* Sidebar Background */
    [data-testid="stSidebar"] { background-color: #E3F2FD; }
    
    /* Filters */
    div[data-testid="stSelectbox"] label {
        font-size: 1.1rem;
        font-weight: 600;
    }

    /* Remove extra top padding */
    .block-container { padding-top: 1rem; }
    h1 { padding-top: 0; margin-top: 0; }
</style>
""", unsafe_allow_html=True)

# 1. Sidebar
with st.sidebar:
    st.title("Le mie Spese")
    selected = option_menu(
        menu_title=None,
        options=["Dashboard", "Elenco", "Analisi", "Confronto"],
        icons=["house", "list-task", "graph-up", "arrow-left-right"],
        menu_icon="cast",
        default_index=0,
        styles={
            "container": {"padding": "0!important", "background-color": "transparent"},
            "icon": {"color": "black", "font-size": "18px"}, 
            "nav-link": {"font-size": "16px", "text-align": "left", "margin":"0px", "--hover-color": "#BBDEFB"},
            "nav-link-selected": {"background-color": "#1565C0", "color": "white"},
        }
    )

if selected == "Dashboard":
    
    st.title("Dashboard")
    st.markdown("---")

    # 1. Upload Section
    c_up1, c_up2, c_up3 = st.columns([0.2, 4, 0.2])
    with c_up2:
        with st.container(border=True):
             uploaded_files = st.file_uploader(
                "Trascina qui i tuoi file Excel (.xlsx)", 
                type=['xlsx'], 
                accept_multiple_files=True
            )
             _, btn_col, _ = st.columns([1, 2, 1])
             with btn_col:
                 if st.button("Carica e Analizza", use_container_width=True):
                    if uploaded_files:
                        st.success(f"Caricamento completato!")
                    else:
                        st.warning("Seleziona almeno un file.")
    
    st.markdown("---") # Re-added per user edit

    # 2. Filters (Stacked)       
    c_center_filt = st.columns([1, 2, 1])[1]
    with c_center_filt:
         selected_year = st.selectbox("Seleziona Anno", ["2024", "2023", "2022"], key="filter_year")
         selected_month = st.selectbox("Seleziona Mese", ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"], key="filter_month")


    # 3. Main Layout
    col_left, col_right = st.columns([2, 1])
    
    # LEFT: Panoramica + Top Categorie
    with col_left:
        
        # PANORAMICA
        with st.container(border=True):
            # Combined Title + Divider HTML to guarantee spacing
            st.markdown("""
                <div class="card-title">Panoramica</div>
                <hr class="custom-hr"/>
            """, unsafe_allow_html=True)
            
            p_chart, p_metrics = st.columns([1.2, 0.8])
            
            with p_chart:
                chart_df = pd.DataFrame({
                    "Tipo": ["Entrate", "Uscite"],
                    "Valore": [467, 242],
                    "Color": ["#4CAF50", "#F44336"]
                })
                st.bar_chart(
                    chart_df.set_index("Tipo"),
                    y="Valore",
                    color="Color",
                    height=200,
                    stack=False
                )

            with p_metrics:
                st.metric("Entrate", "467,00 €", "12%")
                st.write("") 
                st.metric("Uscite", "-242,92 €", "-5%", delta_color="inverse")

        st.write("") 

        # TOP CATEGORIE
        with st.container(border=True):
            st.markdown("""
                <div class="card-title">Dove spendo di più</div>
                <hr class="custom-hr"/>
            """, unsafe_allow_html=True)
            
            cat_data = pd.DataFrame({
                "Categoria": ["Ristoranti", "Viaggi", "Carburante"],
                "Importo": ["55 €", "77 €", "37 €"]
            })
            st.dataframe(
                cat_data,
                hide_index=True,
                use_container_width=True,
                column_config={
                    "Categoria": st.column_config.TextColumn(disabled=True),
                    "Importo": st.column_config.TextColumn(disabled=True)
                }
            )

    # RIGHT: Bonifici
    with col_right:
        # Spacers (User added many)
        st.write("") 
        st.write("")
        st.write("")
        st.write("")
        st.write("")
        st.write("") 
        st.write("")
        st.write("")  
        
        with st.container(border=True):
            st.markdown("""
                <div class="card-title">Bonifici Fatti</div>
                <hr class="custom-hr"/>
            """, unsafe_allow_html=True)
            
            refunds = pd.DataFrame({
                "DA": ["Mario", "Luca", "Paolo"],
                "Importo": ["50€", "20€", "30€"]
            })
            st.dataframe(
                refunds,
                hide_index=True,
                use_container_width=True,
                column_config={
                    "DA": st.column_config.TextColumn(disabled=True),
                    "Importo": st.column_config.TextColumn(disabled=True)
                }
            )

elif selected == "Elenco":
    st.title("Elenco Movimenti")
elif selected == "Analisi":
    st.title("Analisi Dati")
elif selected == "Confronto":
    st.title("Confronto Periodi")
